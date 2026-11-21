"""Share messages, filters and order (``workspaces/{w}/shares/{share}``)."""

from __future__ import annotations

from typing import Literal

from api.aip import filtering
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import ResourceShare
from bomesh.services.workspaces.shares import (
    ShareDraft,
    ShareRecord,
    ShareResolution,
    share_state_column,
    share_target_column,
)
from sqlalchemy import func

Kind = Literal["SHARE", "INVITE"]
Audience = Literal["WORKSPACE", "PEOPLE", "ANYONE"]
State = Literal["ACTIVE", "EXPIRED", "EXHAUSTED", "REVOKED"]


class ShareMessage(ProtoMessage):
    name: str | None = None
    kind: Kind | None = None
    target: str | None = None
    role: str | None = None
    audience: Audience | None = None
    recipients: list[str] | None = None
    expire_time: Timestamp | None = None
    max_uses: int | None = None
    use_count: int | None = None
    state: State | None = None
    uri: str | None = None
    creator: str | None = None
    create_time: Timestamp | None = None
    last_use_time: Timestamp | None = None

    def draft(self) -> ShareDraft:
        """The writable fields; output-only ones are ignored on create."""
        return ShareDraft(
            kind=self.kind,
            target=self.target,
            role=self.role,
            audience=self.audience,
            recipients=tuple(self.recipients or ()),
            expire_time=self.expire_time,
            max_uses=self.max_uses,
        )


class ListSharesResponse(ProtoMessage):
    shares: list[ShareMessage]
    next_page_token: str | None = None


class ShareTokenRequest(ProtoMessage):
    token: str


class ShareResolutionMessage(ProtoMessage):
    share: str
    kind: Kind
    target: str
    target_display_name: str | None = None
    workspace_display_name: str | None = None
    role: str | None = None
    can_open: bool
    can_accept: bool
    reason: str | None = None


def share_message(record: ShareRecord) -> ShareMessage:
    return ShareMessage(
        name=record.name,
        kind=record.kind,
        target=record.target,
        role=record.role,
        audience=record.audience,
        recipients=record.recipients or None,
        expire_time=record.expires_at,
        max_uses=record.max_uses,
        use_count=record.use_count,
        state=record.state,
        uri=record.uri,
        creator=record.creator,
        create_time=record.created_at,
        last_use_time=record.last_used_at,
    )


def resolution_message(resolution: ShareResolution) -> ShareResolutionMessage:
    return ShareResolutionMessage(
        share=resolution.share,
        kind=resolution.kind,
        target=resolution.target,
        target_display_name=resolution.target_display_name,
        workspace_display_name=resolution.workspace_display_name,
        role=resolution.role,
        can_open=resolution.can_open,
        can_accept=resolution.can_accept,
        reason=resolution.reason,
    )


SHARE_FILTERS = FilterSchema(
    {
        "target": filtering.string(share_target_column()),
        "kind": filtering.enum(func.upper(ResourceShare.kind), ("SHARE", "INVITE")),
        "state": filtering.enum(
            share_state_column(), ("ACTIVE", "EXPIRED", "EXHAUSTED", "REVOKED")
        ),
    }
)
SHARE_ORDER = OrderSchema(
    {"createTime": ResourceShare.created_at},
    tie_breaker=[ResourceShare.id],
    default="createTime desc",
)

__all__ = [
    "SHARE_FILTERS",
    "SHARE_ORDER",
    "ListSharesResponse",
    "ShareMessage",
    "ShareResolutionMessage",
    "ShareTokenRequest",
    "resolution_message",
    "share_message",
]
