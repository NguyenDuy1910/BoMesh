"""Write notifications only for recipients allowed to read their subject.

A notification never crosses a permission boundary (``api_design.md`` §1):
every recipient must be an ACTIVE member of the workspace, and when the
subject is an item it must be visible to them (``item_model.md`` §6.3). For
other subjects the emitting service passes ``can_read``, its own read rule
(e.g. the requester or the deciders of a request) over the whole audience at
once. Reads are the Library interface's.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Notification
from bomesh.db.models.workspaces import NOTIFICATION_SUBJECT_TYPES
from bomesh.iam.authorizer import Authorizer, ItemRef
from bomesh.iam.visibility import visible_to

#: The recipients (ACTIVE members of the workspace) who may read the subject.
ReadRule = Callable[[frozenset[UUID]], Awaitable[frozenset[UUID]]]


@dataclass(frozen=True, slots=True)
class NotificationSubject:
    """What a notification is about; ``type`` is a ``notifications.subject_type`` value."""

    type: str
    id: UUID

    def __post_init__(self) -> None:
        if self.type not in NOTIFICATION_SUBJECT_TYPES:
            raise ValueError(f"unknown notification subject type: {self.type}")


class NotificationPublisher:
    """Insert per-recipient notification rows in the caller's transaction."""

    def __init__(self, session: AsyncSession, authorizer: Authorizer) -> None:
        self._session = session
        self._authorizer = authorizer

    async def publish(
        self,
        *,
        workspace_id: UUID,
        recipients: Iterable[UUID],
        kind: str,
        title: str,
        body: str,
        subject: NotificationSubject | None = None,
        can_read: ReadRule | None = None,
    ) -> list[Notification]:
        """Notify every recipient allowed to read ``subject``; returns the rows written.

        ``title`` and ``body`` must not carry content the recipient could not
        otherwise read. A non-item subject requires ``can_read``. The audience
        is authorized in a constant number of queries and written in one INSERT.
        """
        if subject is not None and subject.type != "item" and can_read is None:
            raise ValueError(f"a {subject.type} notification needs a read rule")
        audience = list(dict.fromkeys(recipients))
        readers = await self._readers(workspace_id, frozenset(audience), subject, can_read)
        written = [
            Notification(
                tenant_id=workspace_id,
                recipient_user_id=user_id,
                kind=kind,
                subject_type=subject.type if subject is not None else None,
                subject_id=subject.id if subject is not None else None,
                title=title,
                body=body,
            )
            for user_id in audience
            if user_id in readers
        ]
        if written:
            self._session.add_all(written)
            await self._session.flush()
        return written

    async def _readers(
        self,
        workspace_id: UUID,
        recipients: frozenset[UUID],
        subject: NotificationSubject | None,
        can_read: ReadRule | None,
    ) -> frozenset[UUID]:
        readers = await self._authorizer.active_members(recipients, workspace_id)
        if readers and subject is not None and subject.type == "item":
            item = ItemRef(workspace_id, subject.id)
            readers = (await visible_to(self._authorizer, readers, (item,)))[item]
        if readers and can_read is not None:
            readers &= await can_read(readers)
        return readers


__all__ = ["NotificationPublisher", "NotificationSubject", "ReadRule"]
