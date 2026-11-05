"""Requests (``workspaces/{w}/requests/{request}``): every ask-and-decide flow.

Deciders are permission-based on the request's *decision resource*: the
space (SERVICE, QUESTION, SPACE_MEMBERSHIP), the collection
(COLLECTION_ACCESS) or the connector, a platform resource (CONNECTOR). A
request is visible to its requester and to holders of ``requests.get`` there;
to anyone else it is absent (NOT_FOUND, never listed).

Lifecycle: OPEN ⇄ NEEDS_INFO (``:sendBack`` / the requester's next message),
then APPROVED, DENIED, ANSWERED, WITHDRAWN or CLOSED (``:close`` also ends an
APPROVED or ANSWERED request). ``closeTime`` is the first time a request
reached any of those; ``overdue`` is ``dueTime < now`` while OPEN or
NEEDS_INFO. Approving COLLECTION_ACCESS grants the role on the collection,
SPACE_MEMBERSHIP ``roles/spaceMember`` on the space, both through
:class:`~bomesh.iam.policy.PolicyStore` (ROLE_ESCALATION when the approver
does not hold the role there). The requester and the deciders are notified
of every change made by the other side.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4, uuid5

from sqlalchemy import ColumnElement, and_, false, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Request,
    RequestMessage,
    RequestType,
    Role,
    RoleAssignment,
    Space,
)
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    PermissionDenied,
)
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    PlatformRef,
    Principal,
    SpaceRef,
    WorkspaceRef,
    permission_denied,
)
from bomesh.iam.policy import PolicyStore, workspace_admins
from bomesh.services.collaboration.membership import is_space_member
from bomesh.services.collaboration.records import (
    AssistantContext,
    RequestRecord,
    request_name,
    space_name,
)
from bomesh.services.collaboration.request_types import (
    evaluate,
    find_request_type,
    readable_citations,
    validate_fields,
)
from bomesh.services.collaboration.support import (
    SPACE_MEMBER,
    Gate,
    missing,
    now,
    replay,
)
from bomesh.services.conversations.citations import (
    citation_record,
    readable_source,
    readable_summaries,
)
from bomesh.services.conversations.records import StoredCitation
from bomesh.services.conversations.references import source_message_context
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.notifications import (
    NotificationPublisher,
    NotificationSubject,
)
from bomesh.services.knowledge_items.items import KnowledgeItemService, create_document
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.knowledge_items.records import UploadedFile
from bomesh.services.knowledge_items.summary import (
    get_item_summary,
    visible_or_discoverable_summary,
)
from bomesh.services.workspaces.knowledge_gaps import resolve_knowledge_gap
from bomesh.services.workspaces.members import member_records
from bomesh.services.workspaces.records import parse_member_name

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

KINDS = ("SERVICE", "QUESTION", "COLLECTION_ACCESS", "SPACE_MEMBERSHIP", "CONNECTOR")
SPACE_KINDS = ("service", "question", "space_membership")
ACCESS_KINDS = ("collection_access", "space_membership", "connector")
ACTIVE = ("open", "needs_info")
TERMINAL = ("approved", "denied", "answered", "withdrawn", "closed")
COLLECTION_ROLES = ("roles/collectionViewer", "roles/collectionEditor")
CONNECTOR_NAME = re.compile(r"^connectors/([a-z0-9][a-z0-9_-]{0,63})$")
MAX_TITLE = 255


@dataclass(frozen=True, slots=True)
class NewRequest:
    """CreateRequest input; references are resource names as sent."""

    kind: str
    request_type: str | None = None
    space: str | None = None
    collection: str | None = None
    target: str | None = None
    requested_role: str | None = None
    title: str | None = None
    fields: Mapping[str, Any] = field(default_factory=dict)
    question: str | None = None
    source_message: str | None = None


@dataclass(frozen=True, slots=True)
class Access:
    """What the caller may do with one request."""

    requester: bool
    held: frozenset[str]

    @property
    def decider(self) -> bool:
        return "requests.get" in self.held

    @property
    def visible(self) -> bool:
        return self.requester or self.decider


def decision_ref(
    workspace_id: UUID, request: Request
) -> SpaceRef | ItemRef | PlatformRef:
    """The resource whose permissions decide ``request``."""
    if request.kind == "collection_access":
        return ItemRef(workspace_id, request.collection_item_id)  # type: ignore[arg-type]
    if request.kind == "connector":
        return PlatformRef(f"connectors/{request.connector_key}")
    return SpaceRef(workspace_id, request.space_id)  # type: ignore[arg-type]


async def request_access(
    ctx: RequestContext, workspace_id: UUID, request: Request
) -> Access:
    held = await ctx.authorizer.permissions(
        ctx.principal, decision_ref(workspace_id, request)
    )
    return Access(request.requester_user_id == ctx.user_id, held)


class RequestGate:
    """Open one request: membership, state, ``requests`` module and visibility."""

    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._gate = Gate(sessions)

    async def open(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        permission: str,
        *,
        write: bool,
    ) -> tuple[Request, Access]:
        name = request_name(workspace_id, request_id)
        await self._gate.workspace(
            ctx, workspace_id, "requests", permission, name, write=write
        )
        async with transaction_scope(self._sessions) as session:
            request = await load_request(session, workspace_id, request_id)
        if request is None:
            raise missing(name)
        access = await request_access(ctx, workspace_id, request)
        if not access.visible:
            raise missing(name)
        return request, access


async def load_request(
    session: AsyncSession,
    workspace_id: UUID,
    request_id: UUID,
    *,
    for_update: bool = False,
) -> Request | None:
    statement = select(Request).where(
        Request.id == request_id, Request.tenant_id == workspace_id
    )
    return await session.scalar(
        statement.with_for_update() if for_update else statement
    )


async def request_readable(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    request_id: UUID,
) -> bool:
    """Whether ``principal`` may read the request (GetRequest's rule); False when absent.

    Readers are its requester and holders of ``requests.get`` on its decision resource.
    """
    request = await load_request(session, workspace_id, request_id)
    if request is None:
        return False
    if request.requester_user_id == principal.user_id:
        return True
    held = await authorizer.permissions(principal, decision_ref(workspace_id, request))
    return "requests.get" in held


class RequestService:
    def __init__(
        self,
        sessions: SessionFactory,
        request_hash_secret: bytes,
        items: KnowledgeItemService,
    ) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._items = items
        self._gate = Gate(sessions)
        self._requests = RequestGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> RequestService:
        return cls(
            runtime.sessions(),
            runtime.request_hash_secret(),
            KnowledgeItemService.from_runtime(runtime),
        )

    # -- Create -----------------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewRequest,
        *,
        validate_only: bool,
        request_id: UUID | None,
    ) -> RequestRecord:
        """File a request as the caller; ``validate_only`` returns it with ``eligibility``."""
        parent = f"workspaces/{workspace_id}"
        await self._gate.workspace(
            ctx, workspace_id, "requests", "requests.create", parent, write=True
        )
        await ctx.authorizer.require(
            ctx.principal, "requests.create", WorkspaceRef(workspace_id)
        )
        request = await self._new_request(ctx, workspace_id, spec)
        async with transaction_scope(self._sessions) as session:
            request_type = (
                await session.get(RequestType, request.request_type_id)
                if request.request_type_id is not None
                else None
            )
            if request_type is not None:
                request.fields = validate_fields(request_type, request.fields)
                eligibility = evaluate(
                    request_type,
                    requester=await _profile(session, workspace_id, ctx.user_id),
                    fields=request.fields,
                )
                request.eligibility = eligibility.stored()
                if request_type.sla_duration is not None:
                    request.due_at = request.created_at + request_type.sla_duration
            if validate_only:
                return await _record(session, ctx, workspace_id, request)
            if request.eligibility and request.eligibility["outcome"] == "block":
                raise FailedPrecondition(
                    "The request is not eligible under the request type's rules.",
                    reason="REQUEST_NOT_ELIGIBLE",
                )
            idempotency = Idempotency(session, self._secret)
            key, replayed = await replay(
                idempotency,
                ctx,
                request_id,
                method="CreateRequest",
                parent=parent,
                request=_fingerprint(spec),
            )
            if replayed is not None:
                existing = await load_request(
                    session, workspace_id, UUID(replayed.rsplit("/", 1)[-1])
                )
                if existing is None:
                    raise missing(replayed)
                return await _record(session, ctx, workspace_id, existing)
            if spec.source_message:
                request.assistant_context = await _assistant_context(
                    session, ctx, workspace_id, spec.source_message
                )
            await _require_no_open_ask(session, request)
            session.add(request)
            await session.flush()
            name = request_name(workspace_id, request.id)
            await _audit(session, ctx, workspace_id, "CreateRequest", name)
            await notify_deciders(
                session,
                ctx,
                workspace_id,
                request,
                title="New request",
                body=_summary(request),
            )
            if key is not None:
                await idempotency.remember(key, name)
            return await _record(session, ctx, workspace_id, request)

    async def _new_request(
        self, ctx: RequestContext, workspace_id: UUID, spec: NewRequest
    ) -> Request:
        """An unsaved request with its kind-specific references checked."""
        if spec.kind not in KINDS:
            raise InvalidArgument.for_field(
                "kind", f"kind must be one of {', '.join(KINDS)}."
            )
        kind = spec.kind.lower()
        _require_empty(
            spec,
            allowed={
                "service": {"request_type", "space"},
                "question": {"space"},
                "space_membership": {"space", "requested_role"},
                "collection_access": {"collection", "requested_role"},
                "connector": {"target"},
            }[kind],
        )
        moment = now()
        request = Request(
            id=uuid4(),
            tenant_id=workspace_id,
            kind=kind,
            title=_title(spec.title),
            fields=dict(spec.fields),
            question=spec.question or None,
            requester_user_id=ctx.user_id,
            state="open",
            created_at=moment,
            updated_at=moment,
        )
        match kind:
            case "service":
                await self._service_refs(ctx, workspace_id, spec, request)
            case "question":
                request.space_id = (await self._space(ctx, workspace_id, spec.space)).id
                if not request.question:
                    raise InvalidArgument.for_field(
                        "question", "A QUESTION needs a question."
                    )
            case "space_membership":
                space = await self._space(ctx, workspace_id, spec.space)
                request.space_id = space.id
                role = spec.requested_role or SPACE_MEMBER
                if role != SPACE_MEMBER:
                    raise InvalidArgument.for_field(
                        "requestedRole",
                        f"A SPACE_MEMBERSHIP request asks for '{SPACE_MEMBER}'.",
                    )
                async with transaction_scope(self._sessions) as session:
                    if await is_space_member(
                        session, workspace_id, space.id, ctx.user_id
                    ):
                        raise AlreadyExists("You are already a member of this space.")
                    request.requested_role_id = await _role_id(session, role)
            case "collection_access":
                request.collection_item_id = await self._collection(
                    ctx, workspace_id, spec
                )
                role = spec.requested_role or COLLECTION_ROLES[0]
                if role not in COLLECTION_ROLES:
                    raise InvalidArgument.for_field(
                        "requestedRole",
                        "requestedRole must be roles/collectionViewer or roles/collectionEditor.",
                    )
                async with transaction_scope(self._sessions) as session:
                    request.requested_role_id = await _role_id(session, role)
            case _:
                match = CONNECTOR_NAME.match(spec.target or "")
                if match is None:
                    raise InvalidArgument.for_field(
                        "target",
                        "A CONNECTOR request names its target as connectors/{connector}.",
                    )
                request.connector_key = match[1]
        return request

    async def _service_refs(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewRequest,
        request: Request,
    ) -> None:
        parts = (spec.request_type or "").split("/")
        if not (
            len(parts) == 6
            and parts[:3] == ["workspaces", str(workspace_id), "spaces"]
            and parts[4] == "requestTypes"
        ):
            raise InvalidArgument.for_field(
                "requestType",
                "A SERVICE request names its requestType in this workspace.",
            )
        space = await self._space(ctx, workspace_id, space_name(workspace_id, parts[3]))
        if spec.space and spec.space != space_name(workspace_id, space.code):
            raise InvalidArgument.for_field(
                "space", "space must be the request type's space."
            )
        async with transaction_scope(self._sessions) as session:
            request_type = await find_request_type(session, space.id, parts[5])
        if request_type is None:
            raise missing(spec.request_type or "")
        if request_type.deleted_at is not None:
            raise FailedPrecondition(
                "The request type is deleted and accepts no new requests."
            )
        request.space_id = space.id
        request.request_type_id = request_type.id

    async def _space(
        self, ctx: RequestContext, workspace_id: UUID, name: str | None
    ) -> Space:
        if not name:
            raise InvalidArgument.for_field("space", "space is required for this kind.")
        parts = name.split("/")
        if not (
            len(parts) == 4 and parts[:3] == ["workspaces", str(workspace_id), "spaces"]
        ):
            raise InvalidArgument.for_field(
                "space", f"'{name}' is not a space of this workspace."
            )
        return await self._gate.space(
            ctx, workspace_id, parts[3], "spaces.get", write=False
        )

    async def _collection(
        self, ctx: RequestContext, workspace_id: UUID, spec: NewRequest
    ) -> UUID:
        """A COLLECTION the requester can read or discover (a LOCKED root); else 403."""
        if not spec.collection:
            raise InvalidArgument.for_field("collection", "collection is required.")
        item_id = parse_item(spec.collection, workspace_id, field="collection")
        async with transaction_scope(self._sessions) as session:
            summary = await visible_or_discoverable_summary(
                session, ctx.authorizer, ctx.principal, workspace_id, item_id
            )
        if summary is None or summary.merged_from is not None:
            raise PermissionDenied(
                f"Permission 'items.get' denied on resource '{spec.collection}' "
                "(or it might not exist)",
                metadata={"permission": "items.get", "resource": spec.collection},
            )
        if summary.item_type != "COLLECTION":
            raise InvalidArgument.for_field(
                "collection", "collection must name a COLLECTION item."
            )
        return item_id

    # -- Read -------------------------------------------------------------------

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, request_id: UUID
    ) -> RequestRecord:
        request, _ = await self._requests.open(
            ctx, workspace_id, request_id, "requests.get", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await _record(session, ctx, workspace_id, request)

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        query: ListQuery,
        *,
        filtered_spaces: Iterable[str] = (),
    ) -> list[RequestRecord]:
        """Requests the caller filed or may decide; ``filtered_spaces`` are the space IDs
        the filter names (PERMISSION_DENIED for one the caller cannot read)."""
        parent = f"workspaces/{workspace_id}"
        await self._gate.workspace(
            ctx, workspace_id, "requests", "requests.list", parent, write=False
        )
        await ctx.authorizer.require(
            ctx.principal, "requests.list", WorkspaceRef(workspace_id)
        )
        for code in dict.fromkeys(filtered_spaces):
            await self._readable_space(ctx, workspace_id, code)
        visible = or_(
            Request.requester_user_id == ctx.user_id,
            await _decidable(self._sessions, ctx, workspace_id),
        )
        statement = select(Request).where(Request.tenant_id == workspace_id, visible)
        async with transaction_scope(self._sessions) as session:
            rows = list(await session.scalars(query.apply(statement)))
            return [await _record(session, ctx, workspace_id, row) for row in rows]

    async def _readable_space(
        self, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> None:
        name = space_name(workspace_id, code)
        async with transaction_scope(self._sessions) as session:
            space_id = await session.scalar(
                select(Space.id).where(
                    Space.tenant_id == workspace_id, Space.code == code
                )
            )
        if space_id is None or "spaces.get" not in await ctx.authorizer.permissions(
            ctx.principal, SpaceRef(workspace_id, space_id)
        ):
            raise PermissionDenied(
                f"Permission 'spaces.get' denied on resource '{name}' (or it might not exist)",
                metadata={"permission": "spaces.get", "resource": name},
            )

    # -- Update -----------------------------------------------------------------

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> RequestRecord:
        """``changes`` keyed by mask path: assignee, title, fields."""
        request, access = await self._requests.open(
            ctx, workspace_id, request_id, "requests.update", write=True
        )
        may_update = "requests.update" in access.held
        if not may_update:
            if not access.requester or "assignee" in changes:
                raise permission_denied("requests.update", PlatformRef(_name(request)))
            if request.state not in ACTIVE:
                raise FailedPrecondition(
                    "A requester may edit the request only while it is OPEN or NEEDS_INFO."
                )
        async with transaction_scope(self._sessions) as session:
            row = await _locked(session, workspace_id, request_id)
            etag.check(expected_etag, _etag(row))
            if "assignee" in changes:
                row.assignee_user_id = await _assignee(
                    session, workspace_id, changes["assignee"]
                )
            if "title" in changes:
                row.title = _title(changes["title"])
            if "fields" in changes:
                values = dict(changes["fields"] or {})
                if row.request_type_id is not None:
                    request_type = await session.get(RequestType, row.request_type_id)
                    values = validate_fields(request_type, values)  # type: ignore[arg-type]
                row.fields = values
            row.updated_at = now()
            await session.flush()
            await _audit(session, ctx, workspace_id, "UpdateRequest", _name(row))
            return await _record(session, ctx, workspace_id, row)

    # -- Transitions ------------------------------------------------------------

    async def approve(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        message: str | None,
        role: str | None,
        expected_etag: str | None,
    ) -> RequestRecord:
        """OPEN/NEEDS_INFO → APPROVED, granting what an access or membership request asks."""

        async def grant(session: AsyncSession, row: Request) -> None:
            await _grant(session, ctx, workspace_id, row, role)

        return await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.approve",
            to="approved",
            allowed_from=ACTIVE,
            expected_etag=expected_etag,
            message=message,
            method="ApproveRequest",
            apply=grant,
        )

    async def deny(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        message: str | None,
        expected_etag: str | None,
    ) -> RequestRecord:
        return await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.deny",
            to="denied",
            allowed_from=ACTIVE,
            expected_etag=expected_etag,
            message=message,
            method="DenyRequest",
        )

    async def send_back(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        message: str,
        expected_etag: str | None,
    ) -> RequestRecord:
        if not message or not message.strip():
            raise InvalidArgument.for_field("message", "message is required.")
        return await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.sendBack",
            to="needs_info",
            allowed_from=("open",),
            expected_etag=expected_etag,
            message=message,
            method="SendBackRequest",
        )

    async def close(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        expected_etag: str | None,
    ) -> RequestRecord:
        return await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.close",
            to="closed",
            allowed_from=(*ACTIVE, "approved", "answered"),
            expected_etag=expected_etag,
            method="CloseRequest",
        )

    async def withdraw(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        expected_etag: str | None,
    ) -> RequestRecord:
        """Requester only: OPEN/NEEDS_INFO → WITHDRAWN."""
        return await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.withdraw",
            to="withdrawn",
            allowed_from=ACTIVE,
            expected_etag=expected_etag,
            method="WithdrawRequest",
            requester_only=True,
        )

    async def answer(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        *,
        answer: str,
        publish_to_collection: str | None,
        expected_etag: str | None,
    ) -> RequestRecord:
        """QUESTION/SERVICE → ANSWERED; optionally publish the answer as a DOCUMENT.

        The transition commits first, so a stale etag or a concurrent answer
        publishes nothing; the document is then created with a ``requestId``
        derived from the request, so a retry never publishes a second copy.
        """
        if not answer or not answer.strip():
            raise InvalidArgument.for_field("answer", "answer is required.")
        request, access = await self._requests.open(
            ctx, workspace_id, request_id, "requests.answer", write=True
        )
        _require(access, "requests.answer", request)
        if request.kind not in {"question", "service"}:
            raise FailedPrecondition(
                "Only QUESTION and SERVICE requests are answered.",
                reason="REQUEST_KIND_MISMATCH",
            )
        collection_id = (
            await self._publish_target(ctx, workspace_id, publish_to_collection)
            if publish_to_collection
            else None
        )
        record = await self._transition(
            ctx,
            workspace_id,
            request_id,
            "requests.answer",
            to="answered",
            allowed_from=ACTIVE,
            expected_etag=expected_etag,
            message=answer,
            method="AnswerRequest",
        )
        if collection_id is None:
            return record
        faq_item_id = await self._publish(
            ctx, workspace_id, record.request, answer, collection_id
        )
        async with transaction_scope(self._sessions) as session:
            row = await _locked(session, workspace_id, request_id)
            row.faq_item_id = faq_item_id
            row.updated_at = now()
            question = row.question or row.title
            if question:
                await resolve_knowledge_gap(
                    session,
                    workspace_id,
                    question,
                    decided_by=ctx.user_id,
                    resolved_by_item_id=faq_item_id,
                )
            await session.flush()
            return await _record(session, ctx, workspace_id, row)

    async def _publish_target(
        self, ctx: RequestContext, workspace_id: UUID, collection: str
    ) -> UUID:
        """The ``publishToCollection`` COLLECTION; 403 unless the caller holds ``items.create``."""
        item_id = parse_item(collection, workspace_id, field="publishToCollection")
        async with transaction_scope(self._sessions) as session:
            summary = await get_item_summary(
                session, ctx.authorizer, ctx.principal, workspace_id, item_id
            )
        if summary is None or summary.merged_from is not None:
            raise permission_denied("items.create", PlatformRef(collection))
        if summary.item_type != "COLLECTION":
            raise InvalidArgument.for_field(
                "publishToCollection",
                "publishToCollection must name a COLLECTION item.",
            )
        held = await ctx.authorizer.permissions(
            ctx.principal, ItemRef(workspace_id, item_id)
        )
        if "items.create" not in held:
            raise permission_denied("items.create", PlatformRef(collection))
        return item_id

    async def _publish(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request: Request,
        answer: str,
        collection_id: UUID,
    ) -> UUID:
        title = request.title or request.question or "Answer"
        body = f"# {title}\n\n"
        if request.question:
            body += f"{request.question}\n\n"
        body += f"{answer}\n"
        record = await create_document(
            self._items,
            ctx,
            workspace_id,
            collection_id,
            UploadedFile(
                data=body.encode(),
                file_name=f"{_slug(title)}.md",
                content_type="text/markdown",
            ),
            display_name=title[:MAX_TITLE],
            request_id=uuid5(request.id, "answer"),
        )
        return record.item_id

    async def _transition(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        request_id: UUID,
        permission: str,
        *,
        to: str,
        allowed_from: Sequence[str],
        expected_etag: str | None,
        method: str,
        message: str | None = None,
        apply: Any = None,
        requester_only: bool = False,
    ) -> RequestRecord:
        request, access = await self._requests.open(
            ctx, workspace_id, request_id, permission, write=True
        )
        if requester_only:
            if not access.requester:
                raise permission_denied(permission, PlatformRef(_name(request)))
        else:
            _require(access, permission, request)
        async with transaction_scope(self._sessions) as session:
            row = await _locked(session, workspace_id, request_id)
            etag.check(expected_etag, _etag(row))
            _require_state(row, allowed_from)
            if apply is not None:
                await apply(session, row)
            moment = now()
            row.state = to
            row.updated_at = moment
            if to in TERMINAL and row.closed_at is None:
                row.closed_at = moment
            if to in {"approved", "denied", "answered"}:
                row.decided_by_user_id = ctx.user_id
                row.decided_at = moment
            if message and message.strip():
                session.add(
                    RequestMessage(
                        request_id=row.id, author_user_id=ctx.user_id, text=message
                    )
                )
            await session.flush()
            await _audit(session, ctx, workspace_id, method, _name(row))
            title = f"Request {to.replace('_', ' ')}"
            if access.requester and requester_only:
                await notify_deciders(
                    session, ctx, workspace_id, row, title=title, body=_summary(row)
                )
            else:
                await notify_requester(
                    session, ctx, workspace_id, row, title=title, body=_summary(row)
                )
            return await _record(session, ctx, workspace_id, row)


# -- Visibility -----------------------------------------------------------------


async def _decidable(
    sessions: SessionFactory, ctx: RequestContext, workspace_id: UUID
) -> ColumnElement[bool]:
    """Requests whose decision resource grants the caller ``requests.get``."""
    authorizer, principal = ctx.authorizer, ctx.principal
    clauses: list[ColumnElement[bool]] = []
    if "requests.get" in await authorizer.workspace_permissions(
        principal, workspace_id
    ):
        spaces: ColumnElement[bool] = true()
    else:
        async with transaction_scope(sessions) as session:
            granted = set(
                await session.scalars(
                    select(RoleAssignment.space_id)
                    .join(Space, Space.id == RoleAssignment.space_id)
                    .where(
                        Space.tenant_id == workspace_id,
                        RoleAssignment.user_id == principal.user_id,
                        RoleAssignment.deleted_at.is_(None),
                    )
                )
            )
        decidable = [
            space_id
            for space_id in granted
            if "requests.get" in await authorizer.space_permissions(principal, space_id)
        ]
        spaces = Request.space_id.in_(decidable) if decidable else false()
    clauses.append(and_(Request.kind.in_(SPACE_KINDS), spaces))
    collections = await authorizer.allowed_collections(
        principal, workspace_id, "requests.get"
    )
    if collections:
        clauses.append(
            and_(
                Request.kind == "collection_access",
                Request.collection_item_id.in_(collections),
            )
        )
    if "requests.get" in await authorizer.platform_permissions(principal):
        clauses.append(Request.kind == "connector")
    return or_(*clauses)


def overdue_column() -> ColumnElement[bool]:
    return and_(
        Request.due_at.is_not(None),
        Request.due_at < func.now(),
        Request.state.in_(ACTIVE),
    )


# -- Approving ------------------------------------------------------------------


async def _grant(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    request: Request,
    role: str | None,
) -> None:
    if request.kind not in {"collection_access", "space_membership"}:
        if role:
            raise InvalidArgument.for_field(
                "role",
                "role applies to COLLECTION_ACCESS and SPACE_MEMBERSHIP requests only.",
            )
        return
    requested = await _role_name(session, request.requested_role_id)
    allowed = (
        COLLECTION_ROLES if request.kind == "collection_access" else (SPACE_MEMBER,)
    )
    granted = role or requested
    if granted not in allowed or allowed.index(granted) > allowed.index(requested):
        raise InvalidArgument.for_field(
            "role",
            f"role must be one of {', '.join(allowed[: allowed.index(requested) + 1])}.",
        )
    records = await member_records(session, workspace_id, [request.requester_user_id])
    member = records.get(request.requester_user_id)
    if member is None or member.state != "active":
        raise FailedPrecondition(
            "The requester is no longer an active workspace member.",
            reason="NOT_WORKSPACE_MEMBER",
        )
    ref = decision_ref(workspace_id, request)
    policies = PolicyStore(session, ctx.authorizer)
    await policies.require_grantable(ctx.principal, ref, granted)  # type: ignore[arg-type]
    await policies.add_binding(
        ref,  # type: ignore[arg-type]
        granted,
        f"user:{request.requester_user_id}",
        created_by=ctx.user_id,
    )
    request.granted_role_id = await _role_id(session, granted)


# -- Notifications --------------------------------------------------------------


async def notify_requester(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    request: Request,
    *,
    title: str,
    body: str,
) -> None:
    requester = request.requester_user_id
    if requester == ctx.user_id:
        return

    async def can_read(principal: Principal) -> bool:
        return principal.user_id == requester

    await NotificationPublisher(session, ctx.authorizer).publish(
        workspace_id=workspace_id,
        recipients=[requester],
        kind="request_updated",
        title=title,
        body=body,
        subject=NotificationSubject("request", request.id),
        can_read=can_read,
    )


async def notify_deciders(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    request: Request,
    *,
    title: str,
    body: str,
) -> None:
    """Notify everyone who may decide ``request`` (except the caller)."""
    ref = decision_ref(workspace_id, request)

    async def can_read(principal: Principal) -> bool:
        return "requests.get" in await ctx.authorizer.permissions(principal, ref)

    candidates = await _decider_candidates(session, workspace_id, request)
    await NotificationPublisher(session, ctx.authorizer).publish(
        workspace_id=workspace_id,
        recipients=[user_id for user_id in candidates if user_id != ctx.user_id],
        kind="access_request" if request.kind in ACCESS_KINDS else "request_updated",
        title=title,
        body=body,
        subject=NotificationSubject("request", request.id),
        can_read=can_read,
    )


async def _decider_candidates(
    session: AsyncSession, workspace_id: UUID, request: Request
) -> set[UUID]:
    """People who may hold ``requests.get`` on the decision resource (filtered on publish)."""
    scope: ColumnElement[bool]
    if request.kind == "collection_access":
        scope = RoleAssignment.item_id == request.collection_item_id
    elif request.kind == "connector":
        scope = and_(
            RoleAssignment.tenant_id.is_(None),
            RoleAssignment.item_id.is_(None),
            RoleAssignment.space_id.is_(None),
        )
    else:
        scope = RoleAssignment.space_id == request.space_id
    users = set(
        await session.scalars(
            select(RoleAssignment.user_id).where(
                scope,
                RoleAssignment.deleted_at.is_(None),
                RoleAssignment.user_id.is_not(None),
            )
        )
    )
    users |= await workspace_admins(session, workspace_id)
    if request.assignee_user_id is not None:
        users.add(request.assignee_user_id)
    return users


# -- Records --------------------------------------------------------------------


async def _record(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, request: Request
) -> RequestRecord:
    space_code = None
    if request.space_id is not None:
        space_code = await session.scalar(
            select(Space.code).where(Space.id == request.space_id)
        )
    type_code = None
    if request.request_type_id is not None:
        type_code = await session.scalar(
            select(RequestType.code).where(RequestType.id == request.request_type_id)
        )
    requested_role = (
        await _role_name(session, request.requested_role_id)
        if request.requested_role_id is not None
        else None
    )
    return RequestRecord(
        workspace_id=workspace_id,
        request=request,
        space_code=space_code,
        request_type_code=type_code,
        requested_role=requested_role,
        overdue=_is_overdue(request),
        assistant_context=await _render_context(session, ctx, workspace_id, request),
        eligibility=await _eligibility_for_reader(session, ctx, workspace_id, request),
    )


async def _eligibility_for_reader(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, request: Request
) -> dict[str, Any] | None:
    """Stored eligibility with each ``policyCitation`` the reader cannot read dropped."""
    stored = request.eligibility
    if not stored:
        return None
    results = stored.get("results") or []
    readable = await readable_citations(session, ctx, workspace_id, results)
    return {
        **stored,
        "results": [
            {
                **result,
                "policy_citation_item_id": result.get("policy_citation_item_id")
                if result.get("policy_citation_item_id") in readable
                else None,
            }
            for result in results
        ],
    }


def _is_overdue(request: Request) -> bool:
    return (
        request.due_at is not None
        and request.state in ACTIVE
        and request.due_at < now()
    )


async def _assistant_context(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, source_message: str
) -> dict[str, Any]:
    source = await source_message_context(
        session, ctx.principal, workspace_id, source_message
    )
    return {
        "answer": source.answer,
        "citations": [citation.to_json() for citation in source.citations],
    }


async def _render_context(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, request: Request
) -> AssistantContext | None:
    """``assistantContext`` for this reader (the share rule).

    Citations the reader cannot open keep only ``available: false``; the answer
    text is withheld (empty) when it was built from any item the reader cannot
    read, a merged duplicate included.
    """
    stored = request.assistant_context
    if not stored:
        return None
    cited = [StoredCitation.from_json(entry) for entry in stored.get("citations") or ()]
    summaries = await readable_summaries(
        session, ctx.authorizer, ctx.principal, workspace_id, (c.item_id for c in cited)
    )
    answer = stored.get("answer") or ""
    if not all(readable_source(summaries, citation.item_id) for citation in cited):
        answer = ""
    return AssistantContext(
        answer,
        tuple(citation_record(workspace_id, citation, summaries) for citation in cited),
    )


# -- Helpers --------------------------------------------------------------------


def _require(access: Access, permission: str, request: Request) -> None:
    if permission not in access.held:
        raise permission_denied(permission, PlatformRef(_name(request)))


def _require_state(request: Request, allowed: Sequence[str]) -> None:
    if request.state not in allowed:
        raise FailedPrecondition(
            f"The request is {request.state.upper()}; this transition needs "
            f"{' or '.join(state.upper() for state in allowed)}."
        )


def _name(request: Request) -> str:
    return request_name(request.tenant_id, request.id)


def _etag(request: Request) -> str:
    return etag.compute(_name(request), request.updated_at)


async def _locked(
    session: AsyncSession, workspace_id: UUID, request_id: UUID
) -> Request:
    row = await load_request(session, workspace_id, request_id, for_update=True)
    if row is None:
        raise missing(request_name(workspace_id, request_id))
    return row


async def _require_no_open_ask(session: AsyncSession, request: Request) -> None:
    if request.kind not in ACCESS_KINDS:
        return
    taken = await session.scalar(
        select(Request.id).where(
            Request.tenant_id == request.tenant_id,
            Request.requester_user_id == request.requester_user_id,
            Request.kind == request.kind,
            Request.collection_item_id.is_not_distinct_from(request.collection_item_id),
            Request.space_id.is_not_distinct_from(request.space_id),
            Request.connector_key.is_not_distinct_from(request.connector_key),
            Request.state.in_(ACTIVE),
        )
    )
    if taken is not None:
        raise AlreadyExists(
            "You already have an open request for this resource: "
            f"{request_name(request.tenant_id, taken)}."
        )


async def _role_id(session: AsyncSession, role: str) -> UUID:
    role_id = await session.scalar(
        select(Role.id).where(
            Role.tenant_id.is_(None), Role.code == role.removeprefix("roles/")
        )
    )
    if role_id is None:
        raise InvalidArgument.for_field("requestedRole", f"Unknown role '{role}'.")
    return role_id


async def _role_name(session: AsyncSession, role_id: UUID | None) -> str:
    code = await session.scalar(select(Role.code).where(Role.id == role_id))
    return f"roles/{code}"


async def _assignee(
    session: AsyncSession, workspace_id: UUID, value: str | None
) -> UUID | None:
    if not value:
        return None
    user_id = parse_member_name(value, workspace_id, field="assignee")
    records = await member_records(session, workspace_id, [user_id])
    member = records.get(user_id)
    if member is None or member.state != "active":
        raise FailedPrecondition(
            f"'{value}' is not an active member of this workspace.",
            reason="NOT_WORKSPACE_MEMBER",
        )
    return user_id


async def _profile(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> dict[str, Any]:
    """The ``requester`` variable of eligibility rules."""
    record = (await member_records(session, workspace_id, [user_id])).get(user_id)
    email = record.email if record is not None else ""
    return {
        "displayName": record.display_name if record is not None else "",
        "email": email,
        "emailDomain": email.rpartition("@")[2],
    }


def _require_empty(spec: NewRequest, *, allowed: set[str]) -> None:
    for attribute, json_name in (
        ("request_type", "requestType"),
        ("space", "space"),
        ("collection", "collection"),
        ("target", "target"),
        ("requested_role", "requestedRole"),
    ):
        if attribute not in allowed and getattr(spec, attribute):
            raise InvalidArgument.for_field(
                json_name, f"{json_name} must be empty for a {spec.kind} request."
            )


def _title(value: str | None) -> str | None:
    title = (value or "").strip()
    if len(title) > MAX_TITLE:
        raise InvalidArgument.for_field(
            "title", f"title is longer than {MAX_TITLE} characters."
        )
    return title or None


def _summary(request: Request) -> str:
    return request.title or request.kind.replace("_", " ").capitalize()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "answer"


def _fingerprint(spec: NewRequest) -> dict[str, Any]:
    return {
        "kind": spec.kind,
        "requestType": spec.request_type,
        "space": spec.space,
        "collection": spec.collection,
        "target": spec.target,
        "requestedRole": spec.requested_role,
        "title": spec.title,
        "fields": dict(spec.fields),
        "question": spec.question,
        "sourceMessage": spec.source_message,
    }


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=workspace_id,
        category="requests",
        action=action,
        target=target,
    )


__all__ = [
    "KINDS",
    "Access",
    "NewRequest",
    "RequestGate",
    "RequestService",
    "decision_ref",
    "load_request",
    "notify_deciders",
    "notify_requester",
    "overdue_column",
    "request_access",
    "request_readable",
]
