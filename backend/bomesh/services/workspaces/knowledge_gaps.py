"""Knowledge gaps: recurring questions the knowledge does not answer well.

Gaps are computed on read; only an administrator decision is stored
(``knowledge_gap_decisions``). The rule:

1. A *signal* is an active user message of a live conversation whose answer
   (the next message, an active, completed assistant message) was rated
   unhelpful (``RATED_UNHELPFUL``), cited nothing (``NOT_COVERED``), or cited
   a document past its ``verification.next_review_at`` (``OUTDATED``).
2. Signals cluster by normalized question text: lower-cased, every run of
   characters that are not letters or digits replaced by one space, trimmed.
   The gap ID is the MD5 hex digest of that text.
3. A gap shows its latest wording, the number of signals (``askCount``), the
   last signal time, the most severe reason (RATED_UNHELPFUL > OUTDATED >
   NOT_COVERED) and, as ``suggestedCollection``, the collection its askers
   scoped their conversations to most often.
4. ``state``: DISMISSED with a dismissed decision; RESOLVED with a resolved
   decision not followed by a newer signal; otherwise OPEN.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    DateTime,
    Integer,
    Select,
    String,
    Text,
    and_,
    bindparam,
    case,
    column,
    delete,
    func,
    literal,
    select,
    table,
    true,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import aggregate_order_by, insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import KnowledgeGapDecision
from bomesh.errors import FailedPrecondition, NotFound
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.conversations.queries import answered_question_rows
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.knowledge_items.inventory import reverification_due_ids
from bomesh.services.workspaces.records import KnowledgeGapRecord

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

#: The workspace every gap query is bound to (``{"gap_workspace_id": workspace_id}``).
WORKSPACE_PARAM = "gap_workspace_id"

_UNHELPFUL, _OUTDATED, _NOT_COVERED = 3, 2, 1
_REASONS = {_UNHELPFUL: "RATED_UNHELPFUL", _OUTDATED: "OUTDATED", _NOT_COVERED: "NOT_COVERED"}


def _normalized(text: Any) -> Any:
    """The clustering text of rule 2, computed in PostgreSQL so every caller agrees."""
    return func.btrim(func.regexp_replace(func.lower(text), "[^[:alnum:]]+", " ", "g"))


def _gaps_cte() -> Any:

    workspace_id = bindparam(WORKSPACE_PARAM, type_=PG_UUID(as_uuid=True))
    asked = answered_question_rows(workspace_id).subquery("asked")
    citations = asked.c.citations
    cited = func.jsonb_array_elements(citations).table_valued("value").alias("cited")
    due = reverification_due_ids(workspace_id, func.now()).subquery("due")
    overdue = cited.c.value.op("->>")("item_id").in_(select(due.c.id.cast(String)))
    cited_count = case(
        (func.jsonb_typeof(citations) == "array", func.jsonb_array_length(citations)),
        else_=0,
    )
    severity = case(
        (asked.c.feedback_rating == "unhelpful", _UNHELPFUL),
        (cited_count == 0, _NOT_COVERED),
        (select(true()).select_from(cited).where(overdue).exists(), _OUTDATED),
        else_=0,
    )
    normalized = _normalized(asked.c.content)
    signals = (
        select(
            func.md5(normalized).label("gap_key"),
            asked.c.content.label("content"),
            asked.c.asked_at.label("asked_at"),
            asked.c.scope_collection_id.label("scope_collection_id"),
            severity.label("severity"),
        )
        .where(normalized != "")
        .subquery("signals")
    )
    clusters = (
        select(
            signals.c.gap_key,
            func.left(
                func.array_agg(
                    aggregate_order_by(signals.c.content, signals.c.asked_at.desc())
                )[1],
                1000,
            ).label("question"),
            func.count().label("ask_count"),
            func.max(signals.c.asked_at).label("last_ask_time"),
            func.max(signals.c.severity).label("severity"),
            func.mode().within_group(signals.c.scope_collection_id).label("suggested"),
        )
        .where(signals.c.severity > 0)
        .group_by(signals.c.gap_key)
        .subquery("clusters")
    )
    state = case(
        (KnowledgeGapDecision.state == "dismissed", "DISMISSED"),
        (
            and_(
                KnowledgeGapDecision.state == "resolved",
                clusters.c.last_ask_time <= KnowledgeGapDecision.decided_at,
            ),
            "RESOLVED",
        ),
        else_="OPEN",
    )
    reason = case(
        *((clusters.c.severity == level, label) for level, label in _REASONS.items()),
        else_="NOT_COVERED",
    )
    return (
        select(
            clusters.c.gap_key.label("gap_key"),
            clusters.c.question.label("question"),
            func.cast(clusters.c.ask_count, Integer).label("ask_count"),
            clusters.c.last_ask_time.label("last_ask_time"),
            reason.label("reason"),
            state.label("state"),
            clusters.c.suggested.label("suggested_collection_id"),
        )
        .outerjoin(
            KnowledgeGapDecision,
            and_(
                KnowledgeGapDecision.tenant_id == workspace_id,
                KnowledgeGapDecision.gap_key == clusters.c.gap_key,
            ),
        )
        .cte("knowledge_gaps")
    )


#: The output of the gap query (a CTE named ``knowledge_gaps``); filters and
#: orders refer to these columns. Query it with :func:`gaps_query`.
GAPS = table(
    "knowledge_gaps",
    column("gap_key", String),
    column("question", Text),
    column("ask_count", Integer),
    column("last_ask_time", DateTime(timezone=True)),
    column("reason", String),
    column("state", String),
    column("suggested_collection_id", PG_UUID(as_uuid=True)),
)


def gaps_query() -> Select[Any]:
    """``SELECT`` over :data:`GAPS` for the workspace bound to :data:`WORKSPACE_PARAM`."""
    return select(GAPS).add_cte(_gaps_cte())


async def resolve_knowledge_gap(
    session: AsyncSession,
    workspace_id: UUID,
    question: str,
    *,
    decided_by: UUID,
    resolved_by_item_id: UUID | None = None,
) -> str | None:
    """Mark the gap of ``question`` RESOLVED (e.g. AnswerRequest publishing an answer).

    No permission check; runs in the caller's transaction. The gap key is
    rule 2's, so it matches the gap the question clusters into whether or not
    that gap has been computed yet. A dismissed gap becomes resolved too: an
    answer was published. Returns the gap key, or None for a question with no
    letters or digits.
    """
    normalized = await session.scalar(select(_normalized(literal(question, String))))
    if not normalized:
        return None
    gap_key = str(await session.scalar(select(func.md5(normalized))))
    values = {
        "state": "resolved",
        "resolved_by_item_id": resolved_by_item_id,
        "decided_by_user_id": decided_by,
        "decided_at": datetime.now(UTC),
    }
    await session.execute(
        insert(KnowledgeGapDecision)
        .values(tenant_id=workspace_id, gap_key=gap_key, **values)
        .on_conflict_do_update(
            index_elements=[KnowledgeGapDecision.tenant_id, KnowledgeGapDecision.gap_key],
            set_=values,
        )
    )
    return gap_key


class KnowledgeGapService:
    def __init__(self, sessions: SessionFactory) -> None:
        self._sessions = sessions
        self._resolver = WorkspaceResolver(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> KnowledgeGapService:
        return cls(runtime.sessions())

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> list[KnowledgeGapRecord]:
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "knowledgeGaps.list", write=False
        )
        async with transaction_scope(self._sessions) as session:
            rows = await session.execute(
                query.apply(gaps_query()), {WORKSPACE_PARAM: workspace_id}
            )
            return [_record(workspace_id, row) for row in rows]

    async def get(self, ctx: RequestContext, workspace_id: UUID, gap_key: str) -> KnowledgeGapRecord:
        await self._resolver.open(ctx, WorkspaceRef(workspace_id), "knowledgeGaps.get", write=False)
        async with transaction_scope(self._sessions) as session:
            return await _gap(session, workspace_id, gap_key)

    async def dismiss(
        self, ctx: RequestContext, workspace_id: UUID, gap_key: str
    ) -> KnowledgeGapRecord:
        """OPEN → DISMISSED."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "knowledgeGaps.dismiss", write=True
        )
        async with transaction_scope(self._sessions) as session:
            gap = await _gap(session, workspace_id, gap_key)
            if gap.state != "OPEN":
                raise FailedPrecondition(
                    f"Only an OPEN gap can be dismissed; this one is {gap.state}.",
                    reason="KNOWLEDGE_GAP_NOT_OPEN",
                )
            values = {
                "state": "dismissed",
                "resolved_by_item_id": None,
                "decided_by_user_id": ctx.user_id,
                "decided_at": datetime.now(UTC),
            }
            await session.execute(
                insert(KnowledgeGapDecision)
                .values(tenant_id=workspace_id, gap_key=gap_key, **values)
                .on_conflict_do_update(
                    index_elements=[KnowledgeGapDecision.tenant_id, KnowledgeGapDecision.gap_key],
                    set_=values,
                )
            )
            await _audit(session, ctx, gap, "DismissKnowledgeGap")
            return await _gap(session, workspace_id, gap_key)

    async def reopen(
        self, ctx: RequestContext, workspace_id: UUID, gap_key: str
    ) -> KnowledgeGapRecord:
        """DISMISSED or RESOLVED → OPEN (the decision is removed)."""
        await self._resolver.open(
            ctx, WorkspaceRef(workspace_id), "knowledgeGaps.reopen", write=True
        )
        async with transaction_scope(self._sessions) as session:
            gap = await _gap(session, workspace_id, gap_key)
            if gap.state == "OPEN":
                raise FailedPrecondition(
                    "The gap is already OPEN.", reason="KNOWLEDGE_GAP_ALREADY_OPEN"
                )
            await session.execute(
                delete(KnowledgeGapDecision).where(
                    KnowledgeGapDecision.tenant_id == workspace_id,
                    KnowledgeGapDecision.gap_key == gap_key,
                )
            )
            await _audit(session, ctx, gap, "ReopenKnowledgeGap")
            return await _gap(session, workspace_id, gap_key)


async def _gap(session: AsyncSession, workspace_id: UUID, gap_key: str) -> KnowledgeGapRecord:
    row = (
        await session.execute(
            gaps_query().where(GAPS.c.gap_key == gap_key), {WORKSPACE_PARAM: workspace_id}
        )
    ).first()
    if row is None:
        raise NotFound(
            f"Resource 'workspaces/{workspace_id}/knowledgeGaps/{gap_key}' was not found."
        )
    return _record(workspace_id, row)


def _record(workspace_id: UUID, row: Any) -> KnowledgeGapRecord:
    return KnowledgeGapRecord(
        workspace_id=workspace_id,
        gap_key=row.gap_key,
        question=row.question,
        ask_count=row.ask_count,
        last_ask_time=row.last_ask_time,
        reason=row.reason,
        state=row.state,
        suggested_collection_id=row.suggested_collection_id,
    )


async def _audit(
    session: AsyncSession, ctx: RequestContext, gap: KnowledgeGapRecord, action: str
) -> None:
    await Audit(session).record(
        ctx, workspace_id=gap.workspace_id, category="knowledge", action=action, target=gap.name
    )


__all__ = [
    "GAPS",
    "WORKSPACE_PARAM",
    "KnowledgeGapService",
    "gaps_query",
    "resolve_knowledge_gap",
]
