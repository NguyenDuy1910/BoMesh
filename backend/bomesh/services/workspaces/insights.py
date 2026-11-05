"""WorkspaceOverview (admin home) and platform usage (``workspaces:summarizeUsage``/``:exportUsage``).

Definitions (``api_design.md`` §4):

- a *question* is an active user message of a live conversation;
- *active members* (KPI, usage) are live ACTIVE memberships whose
  ``last_active_at`` falls in the window; the daily series counts the
  members who asked a question that day;
- *processed documents* are distinct DOCUMENT items whose ingestion task
  succeeded in the window;
- attention items count, among live items, IN_REVIEW contributions,
  documents whose processing failed (``PUBLISH_FAILED``), published documents
  past ``verification.next_review_at``, unpaused sources whose latest sync
  failed, workspace connections needing reauthorization, OPEN collection-access
  and space-membership requests, and unpublished documents outside system
  collections. Each points at the single resource or, when several, at their
  collection.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import Select, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Operation, Tenant, TenantMembership
from bomesh.iam.authorizer import PlatformRef, WorkspaceRef
from bomesh.services.collaboration.queries import open_access_request_ids
from bomesh.services.collaboration.records import request_name
from bomesh.services.conversations.queries import question_rows
from bomesh.services.ingestion.names import connection_name, source_name
from bomesh.services.ingestion.queries import (
    expired_connection_codes,
    failing_source_codes,
    processed_document_rows,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.operations import Operations
from bomesh.services.kernel.workspaces import WorkspaceResolver, workspace_name
from bomesh.services.knowledge_curation.queries import in_review_contribution_ids
from bomesh.services.knowledge_curation.records import contribution_name
from bomesh.services.knowledge_items.inventory import (
    failed_document_ids,
    published_document_ids,
    reverification_due_ids,
    root_collection_ids,
    unpublished_document_ids,
)
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.workspaces.exports import run_export
from bomesh.services.workspaces.records import (
    AttentionItem,
    DailyUsage,
    Kpi,
    WorkspaceOverview,
    WorkspaceUsage,
)
from bomesh.services.workspaces.support import (
    DEFAULT_WINDOW,
    own_operation,
    time_zone,
    window_days,
)
from bomesh.storage import DocumentStorage

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

_WORKSPACES = PlatformRef("workspaces")


class InsightService:
    def __init__(
        self, sessions: SessionFactory, storage: DocumentStorage, request_hash_secret: bytes
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._secret = request_hash_secret
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> InsightService:
        return cls(runtime.sessions(), runtime.object_storage(), runtime.request_hash_secret())

    # -- Overview -------------------------------------------------------------

    async def overview(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        window: str | None,
        zone: str | None,
    ) -> WorkspaceOverview:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "workspaces.getOverview", write=False
        )
        window = window or DEFAULT_WINDOW
        days = window_days(window)
        zone_name = time_zone(zone)
        now = datetime.now(UTC)
        start = now - timedelta(days=days)
        async with transaction_scope(self._sessions) as session:
            attention = await _attention(session, workspace_id, now)
            kpis = await _kpis(session, workspace_id, start, now - timedelta(days=2 * days))
            daily = await _daily_usage(session, workspace_id, now, days, zone_name)
        return WorkspaceOverview(
            workspace_id=workspace_id,
            window=window,
            time_zone=zone_name,
            attention_items=attention,
            kpis=kpis,
            daily_usage=daily,
        )

    # -- Usage ------------------------------------------------------------------

    async def summarize_usage(
        self, ctx: RequestContext, *, window: str | None
    ) -> list[WorkspaceUsage]:
        await ctx.authorizer.require(ctx.principal, "workspaces.summarizeUsage", _WORKSPACES)
        since = datetime.now(UTC) - timedelta(days=window_days(window))
        async with transaction_scope(self._sessions) as session:
            return await _usage(session, since)

    async def export_usage(
        self, ctx: RequestContext, *, window: str | None, request_id: UUID | None
    ) -> Operation:
        """Write the usage of every workspace as CSV; the returned operation is done."""
        await ctx.authorizer.require(ctx.principal, "workspaces.exportUsage", _WORKSPACES)
        window = window or DEFAULT_WINDOW
        since = datetime.now(UTC) - timedelta(days=window_days(window))
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="ExportWorkspaceUsage",
                    parent="",
                    request={"window": window},
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await own_operation(session, ctx.user_id, replayed)
            operation = await Operations(session).create(
                ctx.principal, verb="exportUsage", target="workspaces", workspace_id=None
            )
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="settings",
                action="ExportWorkspaceUsage",
                target="workspaces",
                resource_type="workspace",
                details={"window": window},
            )
            if key is not None:
                await idempotency.remember(key, f"operations/{operation.id}")

        async def rows(session: AsyncSession) -> list[list[str]]:
            usage = await _usage(session, since)
            return [_USAGE_HEADER] + [
                [
                    entry.workspace,
                    window,
                    str(entry.question_count),
                    str(entry.active_member_count),
                    str(entry.processed_document_count),
                ]
                for entry in usage
            ]

        await run_export(
            self._sessions, self._storage, operation_id=operation.id, kind="usage", rows=rows
        )
        async with transaction_scope(self._sessions) as session:
            return await own_operation(session, ctx.user_id, f"operations/{operation.id}")


# -- Usage ------------------------------------------------------------------------

_USAGE_HEADER = [
    "workspace",
    "window",
    "questionCount",
    "activeMemberCount",
    "processedDocumentCount",
]


def _questions() -> Any:
    """Conversations' question rows (``tenant_id``, ``user_id``, ``asked_at``) as a subquery."""

    return question_rows().subquery("questions")


async def _usage(session: AsyncSession, since: datetime) -> list[WorkspaceUsage]:

    asked = _questions()
    questions = (
        select(func.count())
        .select_from(asked)
        .where(asked.c.tenant_id == Tenant.id, asked.c.asked_at >= since)
        .scalar_subquery()
    )
    active = (
        select(func.count())
        .where(
            TenantMembership.tenant_id == Tenant.id,
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
            TenantMembership.last_active_at >= since,
        )
        .scalar_subquery()
    )
    runs = processed_document_rows().subquery("processed")
    processed = (
        select(func.count(distinct(runs.c.item_id)))
        .where(runs.c.tenant_id == Tenant.id, runs.c.processed_at >= since)
        .scalar_subquery()
    )
    rows = await session.execute(
        select(Tenant.id, questions, active, processed).order_by(Tenant.code)
    )
    return [
        WorkspaceUsage(workspace_id, int(q or 0), int(a or 0), int(p or 0))
        for workspace_id, q, a, p in rows
    ]


# -- Overview ---------------------------------------------------------------------

#: An attention probe: kind, the owner's id query, the collection target, the single target.
_Probe = tuple[str, Select[Any], str, Callable[[Any], str]]


def _probes(workspace_id: UUID, now: datetime) -> list[_Probe]:

    ws = workspace_name(workspace_id)

    def item(item_id: Any) -> str:
        return item_name(workspace_id, item_id)

    return [
        (
            "CONTRIBUTIONS_WAITING",
            in_review_contribution_ids(workspace_id),
            f"{ws}/contributions",
            lambda contribution_id: contribution_name(workspace_id, contribution_id),
        ),
        ("PUBLISH_FAILED", failed_document_ids(workspace_id), f"{ws}/items", item),
        (
            "REVERIFICATION_DUE",
            reverification_due_ids(workspace_id, now),
            f"{ws}/items",
            item,
        ),
        (
            "SOURCE_FAILING",
            failing_source_codes(workspace_id),
            f"{ws}/sources",
            lambda code: source_name(workspace_id, code),
        ),
        (
            "CONNECTION_EXPIRED",
            expired_connection_codes(workspace_id),
            f"{ws}/connections",
            lambda code: connection_name(workspace_id, code),
        ),
        (
            "ACCESS_REQUESTS",
            open_access_request_ids(workspace_id),
            f"{ws}/requests",
            lambda request_id: request_name(workspace_id, request_id),
        ),
        (
            "DOCUMENTS_WAITING_TO_PUBLISH",
            unpublished_document_ids(workspace_id),
            f"{ws}/items",
            item,
        ),
    ]


async def _attention(
    session: AsyncSession, workspace_id: UUID, now: datetime
) -> tuple[AttentionItem, ...]:
    items: list[AttentionItem] = []
    for kind, ids, collection, single in _probes(workspace_id, now):
        found = list(await session.scalars(ids.limit(2)))
        if not found:
            continue
        count = await _count(session, ids)
        target = single(found[0]) if count == 1 else collection
        items.append(AttentionItem(kind, count, target))
    return tuple(items)


async def _kpis(
    session: AsyncSession, workspace_id: UUID, start: datetime, previous_start: datetime
) -> tuple[Kpi, ...]:
    asked = _questions()
    in_workspace = select(asked.c.asked_at).where(asked.c.tenant_id == workspace_id)
    questions = await _count(session, in_workspace.where(asked.c.asked_at >= start))
    previous_questions = await _count(
        session,
        in_workspace.where(asked.c.asked_at >= previous_start, asked.c.asked_at < start),
    )
    active_members = await _count(
        session,
        select(TenantMembership.user_id).where(
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.status == "active",
            TenantMembership.deleted_at.is_(None),
            TenantMembership.last_active_at >= start,
        ),
    )
    root_collections = await _count(session, root_collection_ids(workspace_id))
    previous_roots = await _count(session, root_collection_ids(workspace_id, at=start))
    published = await _count(session, published_document_ids(workspace_id))
    return (
        Kpi("questions", questions, previous_questions),
        Kpi("activeMembers", active_members),
        Kpi("rootCollections", root_collections, previous_roots),
        Kpi("publishedDocuments", published),
    )


async def _daily_usage(
    session: AsyncSession, workspace_id: UUID, now: datetime, days: int, zone: str
) -> tuple[DailyUsage, ...]:
    local_today = now.astimezone(ZoneInfo(zone)).date()
    first_day = local_today - timedelta(days=days - 1)
    asked = _questions()
    local_date = func.date(func.timezone(zone, asked.c.asked_at)).label("day")
    rows = await session.execute(
        select(local_date, func.count(), func.count(distinct(asked.c.user_id)))
        .select_from(asked)
        .where(
            asked.c.tenant_id == workspace_id,
            asked.c.asked_at >= now - timedelta(days=days + 1),
        )
        .group_by(local_date)
    )
    by_day: dict[date, tuple[int, int]] = {day: (int(q), int(a)) for day, q, a in rows}
    return tuple(
        DailyUsage(
            date=(first_day + timedelta(days=offset)).isoformat(),
            question_count=by_day.get(first_day + timedelta(days=offset), (0, 0))[0],
            active_member_count=by_day.get(first_day + timedelta(days=offset), (0, 0))[1],
        )
        for offset in range(days)
    )


async def _count(session: AsyncSession, statement: Select[Any]) -> int:
    return int(await session.scalar(select(func.count()).select_from(statement.subquery())) or 0)


__all__ = ["InsightService"]
