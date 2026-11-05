"""AIP-155 ``requestId``: one stored result per successful idempotent write.

Usage, inside the write's own transaction (``design.dbml`` ``request_idempotency``)::

    key = idempotency.key(ctx.principal, request_id, method="CreateItem",
                          parent=parent_name, request=body)
    if (name := await idempotency.replay(key)) is not None:
        return await self.get(ctx, name)          # re-read and re-authorize
    created = ...                                 # the write
    await idempotency.remember(key, created_name)

``replay`` serializes concurrent duplicates on a transaction advisory lock, so
the second caller waits for the first and then replays its result. A failed
write rolls back and leaves no row; ``validateOnly`` never calls ``remember``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import RequestIdempotency
from bomesh.errors import InvalidArgument
from bomesh.iam.authorizer import Principal

RETENTION = timedelta(hours=24)


@dataclass(frozen=True, slots=True)
class IdempotencyKey:
    user_id: UUID | None
    request_id: UUID
    method: str
    parent: str
    request_hash: bytes


class Idempotency:
    """``requestId`` bookkeeping in the caller's session.

    ``secret`` is the deployment key the request hash is keyed with, so a
    stored hash of a body holding a password is not crackable offline.
    """

    def __init__(self, session: AsyncSession, secret: bytes) -> None:
        self._session = session
        self._secret = secret

    def key(
        self,
        principal: Principal | None,
        request_id: UUID,
        *,
        method: str,
        parent: str,
        request: Mapping[str, Any],
    ) -> IdempotencyKey:
        """Fingerprint one request: ``method`` is the operationId, ``request`` the parsed
        query and body without ``requestId`` (JSON-serializable)."""
        canonical = json.dumps(
            {"method": method, "parent": parent, "request": request},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return IdempotencyKey(
            user_id=principal.user_id if principal is not None else None,
            request_id=request_id,
            method=method,
            parent=parent,
            request_hash=hmac.new(self._secret, canonical.encode(), hashlib.sha256).digest(),
        )

    async def replay(self, key: IdempotencyKey) -> str | None:
        """The stored result name of an earlier identical request, or None to execute.

        The same ``requestId`` with a different method, parent or request is
        INVALID_ARGUMENT ``REQUEST_ID_REUSED``. Expired rows count as absent.
        """
        await self._session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock, 0))"),
            {"lock": f"request_idempotency:{key.user_id}:{key.request_id}"},
        )
        row = await self._session.scalar(
            select(RequestIdempotency).where(
                RequestIdempotency.user_id.is_not_distinct_from(key.user_id),
                RequestIdempotency.request_id == key.request_id,
            )
        )
        if row is None:
            return None
        if row.expires_at <= await self._now():
            return None
        if (row.method, row.parent) != (key.method, key.parent) or not hmac.compare_digest(
            row.request_hash, key.request_hash
        ):
            raise InvalidArgument.for_field(
                "requestId",
                "This requestId was already used for a different request.",
                reason="REQUEST_ID_REUSED",
            )
        return row.result_name

    async def remember(self, key: IdempotencyKey, result_name: str) -> None:
        """Record the result of the write that just succeeded in this transaction.

        An expired row of the same ``requestId`` is overwritten.
        """
        now = await self._now()
        values = {
            "method": key.method,
            "parent": key.parent,
            "request_hash": key.request_hash,
            "result_name": result_name,
            "created_at": now,
            "expires_at": now + RETENTION,
        }
        await self._session.execute(
            insert(RequestIdempotency)
            .values(id=uuid4(), user_id=key.user_id, request_id=key.request_id, **values)
            .on_conflict_do_update(
                index_elements=[RequestIdempotency.user_id, RequestIdempotency.request_id],
                set_=values,
            )
        )

    async def _now(self) -> datetime:
        value = await self._session.scalar(select(func.now()))
        return value if value is not None else datetime.now(UTC)


__all__ = ["RETENTION", "Idempotency", "IdempotencyKey"]
