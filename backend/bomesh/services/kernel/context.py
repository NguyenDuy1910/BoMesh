"""The caller of one request, as every service receives it."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from bomesh.iam.authorizer import Authorizer, Principal, WorkspaceAccess


@dataclass(frozen=True, slots=True)
class RequestContext:
    """Who calls, the request-scoped :class:`Authorizer`, and request metadata.

    ``request_id`` is the transport correlation id (``X-Request-Id``), not the
    AIP-155 ``requestId`` of a write; ``ip_address`` is recorded in audit events.
    """

    principal: Principal
    authorizer: Authorizer
    request_id: str | None = None
    ip_address: str | None = None

    @property
    def user_id(self) -> UUID:
        return self.principal.user_id

    def in_workspace(self, workspace_id: UUID) -> WorkspaceAccess:
        """The caller acting in ``workspace_id``, as engines take it."""
        return WorkspaceAccess(self.principal, workspace_id, self.authorizer)


__all__ = ["RequestContext"]
