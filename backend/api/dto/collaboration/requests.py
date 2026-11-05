"""Request and RequestMessage messages, with their transition bodies and list schemas."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal
from uuid import UUID

from pydantic import Field
from sqlalchemy import func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from api.dto.conversations import CitationMessage, citation_message
from bomesh.db.models import Request, RequestMessage
from bomesh.services.collaboration.membership import space_id_by_code
from bomesh.services.collaboration.records import (
    RequestMessageRecord,
    RequestRecord,
    request_type_name,
    space_name,
)
from bomesh.services.collaboration.requests import NewRequest, overdue_column
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.records import member_name, parse_member_name

Kind = Literal[
    "SERVICE", "QUESTION", "COLLECTION_ACCESS", "SPACE_MEMBERSHIP", "CONNECTOR"
]
State = Literal[
    "OPEN", "NEEDS_INFO", "APPROVED", "DENIED", "ANSWERED", "WITHDRAWN", "CLOSED"
]


class RequestEligibilityResultMessage(ProtoMessage):
    condition: str | None = None
    message: str | None = None
    policy_citation: str | None = None
    severity: Literal["BLOCK", "WARN"] | None = None


class RequestEligibilityMessage(ProtoMessage):
    outcome: Literal["PASS", "WARN", "BLOCK"] | None = None
    results: list[RequestEligibilityResultMessage] | None = None


class RequestAssistantContextMessage(ProtoMessage):
    answer: str | None = None
    citations: list[CitationMessage] | None = None


class RequestResource(ProtoMessage):
    """The ``Request`` resource (``RequestMessage`` is the request's message resource)."""

    name: str | None = None
    uid: str | None = None
    kind: Kind | None = None
    request_type: str | None = None
    space: str | None = None
    collection: str | None = None
    target: str | None = None
    requested_role: str | None = None
    title: str | None = None
    fields: dict[str, Any] | None = None
    question: str | None = None
    source_message: str | None = None
    assistant_context: RequestAssistantContextMessage | None = None
    requester: str | None = None
    assignee: str | None = None
    state: State | None = None
    due_time: Timestamp | None = None
    overdue: bool | None = None
    eligibility: RequestEligibilityMessage | None = None
    faq_item: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    close_time: Timestamp | None = None
    etag: str | None = None


class ListRequestsResponse(ProtoMessage):
    requests: list[RequestResource] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


class AnswerRequestRequest(ProtoMessage):
    answer: str
    publish_to_collection: str | None = None
    etag: str | None = None


class ApproveRequestRequest(ProtoMessage):
    message: str | None = None
    role: str | None = None
    etag: str | None = None


class CloseRequestRequest(ProtoMessage):
    etag: str | None = None


class DenyRequestRequest(ProtoMessage):
    message: str | None = None
    etag: str | None = None


class SendBackRequestRequest(ProtoMessage):
    message: str
    etag: str | None = None


class WithdrawRequestRequest(ProtoMessage):
    etag: str | None = None


def new_request(body: RequestResource) -> NewRequest:
    return NewRequest(
        kind=body.kind or "",
        request_type=body.request_type,
        space=body.space,
        collection=body.collection,
        target=body.target,
        requested_role=body.requested_role,
        title=body.title,
        fields=body.fields or {},
        question=body.question,
        source_message=body.source_message,
    )


def _eligibility(record: RequestRecord) -> RequestEligibilityMessage | None:
    stored = record.eligibility
    if not stored:
        return None
    return RequestEligibilityMessage(
        outcome=stored["outcome"].upper(),
        results=[
            RequestEligibilityResultMessage(
                condition=result["condition"],
                message=result.get("message"),
                severity=result["severity"].upper(),
                policy_citation=(
                    item_name(
                        record.workspace_id, UUID(result["policy_citation_item_id"])
                    )
                    if result.get("policy_citation_item_id")
                    else None
                ),
            )
            for result in stored.get("results") or ()
        ],
    )


def request_message(record: RequestRecord) -> RequestResource:
    row = record.request
    ws = record.workspace_id
    context = record.assistant_context
    return RequestResource(
        name=record.name,
        uid=str(row.id),
        kind=row.kind.upper(),  # type: ignore[arg-type]
        request_type=(
            request_type_name(ws, record.space_code, record.request_type_code)
            if record.space_code and record.request_type_code
            else None
        ),
        space=space_name(ws, record.space_code) if record.space_code else None,
        collection=item_name(ws, row.collection_item_id)
        if row.collection_item_id
        else None,
        target=f"connectors/{row.connector_key}" if row.connector_key else None,
        requested_role=record.requested_role,
        title=row.title,
        fields=dict(row.fields),
        question=row.question,
        assistant_context=(
            RequestAssistantContextMessage(
                answer=context.answer,
                citations=[
                    citation_message(citation) for citation in context.citations
                ],
            )
            if context is not None
            else None
        ),
        requester=member_name(ws, row.requester_user_id),
        assignee=member_name(ws, row.assignee_user_id)
        if row.assignee_user_id
        else None,
        state=row.state.upper(),  # type: ignore[arg-type]
        due_time=row.due_at,
        overdue=record.overdue,
        eligibility=_eligibility(record),
        faq_item=item_name(ws, row.faq_item_id) if row.faq_item_id else None,
        create_time=row.created_at,
        update_time=row.updated_at,
        close_time=row.closed_at,
        etag=record.etag,
    )


def _member_converter(workspace_id: UUID) -> Callable[[str], UUID | None]:
    def convert(name: str) -> UUID | None:
        return parse_member_name(name, workspace_id, field="filter") if name else None

    return convert


def _space_converter(workspace_id: UUID) -> Callable[[str], Any]:
    def convert(name: str) -> Any:
        code = parse_space_name(name, workspace_id, field="filter")
        return space_id_by_code(workspace_id, code)

    return convert


REQUEST_FIELDS = MutableFields(("assignee", "title", "fields"))


def request_filters(workspace_id: UUID) -> FilterSchema:
    """The ListRequests filter; references must name this workspace's members and spaces."""
    member = _member_converter(workspace_id)
    return FilterSchema(
        {
            "requester": filtering.resource_name(Request.requester_user_id, member),
            "assignee": filtering.resource_name(Request.assignee_user_id, member),
            "state": filtering.enum(func.upper(Request.state), State.__args__),
            "space": filtering.resource_name(
                Request.space_id, _space_converter(workspace_id)
            ),
            "kind": filtering.enum(func.upper(Request.kind), Kind.__args__),
            "overdue": filtering.boolean(overdue_column()),
        }
    )


REQUEST_ORDER = OrderSchema(
    {
        "createTime": Request.created_at,
        "dueTime": Request.due_at,
        "updateTime": Request.updated_at,
    },
    tie_breaker=[Request.id],
    default="createTime desc",
)


# -- Request messages -----------------------------------------------------------


class RequestMessageMessage(ProtoMessage):
    name: str | None = None
    author: str | None = None
    text: str
    internal: bool | None = None
    create_time: Timestamp | None = None


class ListRequestMessagesResponse(ProtoMessage):
    messages: list[RequestMessageMessage] = Field(default_factory=list)
    next_page_token: str | None = None
    total_size: int | None = None


def request_message_message(record: RequestMessageRecord) -> RequestMessageMessage:
    message = record.message
    return RequestMessageMessage(
        name=record.name,
        author=member_name(record.workspace_id, message.author_user_id),
        text=message.text,
        internal=message.internal,
        create_time=message.created_at,
    )


def request_message_filters(workspace_id: UUID) -> FilterSchema:
    return FilterSchema(
        {
            "internal": filtering.boolean(RequestMessage.internal),
            "author": filtering.resource_name(
                RequestMessage.author_user_id, _member_converter(workspace_id)
            ),
        }
    )


REQUEST_MESSAGE_ORDER = OrderSchema(
    {"createTime": RequestMessage.created_at},
    tie_breaker=[RequestMessage.id],
    default="createTime",
)
