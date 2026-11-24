"""Who assigned a document's topics: confirming the assistant's, and corrections.

An ``item_topics`` row with ``created_by_user_id`` NULL is the assistant's
(``document.assistantTopics``). ConfirmTopicAssignments turns one topic's
assistant rows on the documents a ListItems filter matches into the caller's,
narrowed silently to visible documents whose governing collection grants the
caller ``items.update``. A TopicCorrection records a person's change away from
the assistant's topics (ApproveContribution ``recordCorrection``, UpdateItem
``document.topics``; both call :func:`record_topic_correction` in their own
transaction); admins holding ``topics.update`` read and dismiss them.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Row,
    ScalarSelect,
    Select,
    Uuid,
    and_,
    delete,
    func,
    insert,
    literal,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Contribution,
    ContributionTopic,
    Item,
    ItemTopic,
    Topic,
    TopicCorrection,
    TopicCorrectionChange,
)
from bomesh.errors import FailedPrecondition, NotFound
from bomesh.iam.authorizer import WorkspaceRef, permission_denied
from bomesh.iam.visibility import ItemVisibility, item_visibility
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import is_purged
from bomesh.services.knowledge_curation.records import (
    TopicCorrectionRecord,
    topic_correction_name,
    topic_name,
)
from bomesh.services.knowledge_curation.support import CurationDeps, referenced_item

MANAGE = "topics.update"
_ACCEPT = "topics.accept"
#: The suggestions CLASSIFYING replaces: topics, summary and title, and their confidences.
_CLASSIFIED_SUGGESTIONS = frozenset(
    {"topics_confidence", "proposed_topics_confidence", "summary", "summary_confidence", "title"}
)


class TopicAssignmentService:
    def __init__(self, deps: CurationDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> TopicAssignmentService:
        return cls(CurationDeps.from_runtime(runtime))

    async def confirm(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        where: ColumnElement[bool],
        *,
        referenced: frozenset[UUID] = frozenset(),
    ) -> int:
        """ConfirmTopicAssignments: ``where`` is the compiled ListItems filter (over ``Item``).

        Returns how many assignments became the caller's.
        """
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "topics.get", write=True)
        visibility = await item_visibility(ctx.authorizer, ctx.principal, workspace_id)
        # Documents governed by a collection the caller both reads and edits: exactly the
        # visible documents whose governing collection grants items.update.
        editable = ItemVisibility(
            workspace_id, visibility.readable & visibility.editable, visibility.editable
        )
        documents = select(Item.id).where(Item.item_kind == "document", editable.clause(), where)
        # An alias, so that filter subqueries over item_topics never correlate to the target.
        assignments = ItemTopic.__table__.alias("confirmed_assignments")
        async with transaction_scope(self._deps.sessions) as session:
            topic = await self._active_topic(session, ctx, workspace_id, code)
            for item_id in referenced:
                await referenced_item(session, ctx, workspace_id, item_id)
            result = await session.execute(
                update(assignments)
                .where(
                    assignments.c.topic_id == topic.id,
                    assignments.c.created_by_user_id.is_(None),
                    assignments.c.item_id.in_(documents),
                )
                .values(created_by_user_id=ctx.user_id)
            )
            confirmed = int(result.rowcount or 0)  # type: ignore[attr-defined]
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="ConfirmTopicAssignments",
                target=topic_name(workspace_id, code),
                details={"confirmedCount": confirmed},
            )
        return confirmed

    async def get_correction(
        self, ctx: RequestContext, workspace_id: UUID, correction_id: UUID
    ) -> TopicCorrectionRecord:
        await self._open(ctx, workspace_id, write=False)
        visible = await _visible_items(ctx, workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            return await _correction(session, workspace_id, visible, correction_id)

    async def list_corrections(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[TopicCorrectionRecord], int]:
        await self._open(ctx, workspace_id, write=False)
        visible = await _visible_items(ctx, workspace_id)
        counted = select(TopicCorrection.id).where(TopicCorrection.tenant_id == workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(counted)) or 0)
            rows = await session.execute(query.apply(_corrections(workspace_id, visible)))
            return [_correction_record(workspace_id, row) for row in rows], total

    async def dismiss_correction(
        self, ctx: RequestContext, workspace_id: UUID, correction_id: UUID
    ) -> TopicCorrectionRecord:
        """DismissTopicCorrection: OPEN → DISMISSED; an already DISMISSED one is unchanged."""
        await self._open(ctx, workspace_id, write=True)
        visible = await _visible_items(ctx, workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            dismissed = await session.scalar(
                update(TopicCorrection)
                .where(
                    TopicCorrection.tenant_id == workspace_id,
                    TopicCorrection.id == correction_id,
                    TopicCorrection.dismissed_at.is_(None),
                )
                .values(dismissed_at=func.now())
                .returning(TopicCorrection.id)
                .execution_options(synchronize_session=False)
            )
            if dismissed is not None:
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="knowledge",
                    action="DismissTopicCorrection",
                    target=topic_correction_name(workspace_id, correction_id),
                )
            return await _correction(session, workspace_id, visible, correction_id)

    # -- Internals -----------------------------------------------------------------

    async def _open(self, ctx: RequestContext, workspace_id: UUID, *, write: bool) -> None:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), MANAGE, write=write)

    async def _active_topic(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str
    ) -> Topic:
        """The topic as GetTopic sees it; only an ACTIVE, live one has assignments to confirm."""
        topic = await session.scalar(
            select(Topic).where(Topic.tenant_id == workspace_id, Topic.code == code)
        )
        if topic is None or is_purged(topic.deleted_at):
            raise NotFound(f"Resource '{topic_name(workspace_id, code)}' was not found.")
        if topic.state != "active" and _ACCEPT not in await ctx.authorizer.workspace_permissions(
            ctx.principal, workspace_id
        ):
            raise permission_denied("topics.get", WorkspaceRef(workspace_id))
        if topic.state != "active" or topic.deleted_at is not None:
            raise FailedPrecondition("Only an ACTIVE topic's assignments can be confirmed.")
        return topic


# -- Records -------------------------------------------------------------------------


def _changed_topic_codes(change_type: str) -> ScalarSelect[Any]:
    """Sorted codes of the correction's ``change_type`` topics (correlated subquery)."""
    return (
        select(func.array_agg(aggregate_order_by(Topic.code, Topic.code)))
        .select_from(TopicCorrectionChange)
        .join(Topic, Topic.id == TopicCorrectionChange.topic_id)
        .where(
            TopicCorrectionChange.topic_correction_id == TopicCorrection.id,
            TopicCorrectionChange.change_type == change_type,
        )
        .correlate(TopicCorrection)
        .scalar_subquery()
    )


def _corrections(workspace_id: UUID, visible: ColumnElement[bool]) -> Select[Any]:
    """The workspace's corrections, each with its Document (only when ``visible``) and its
    removed and added topic codes, in one query."""
    return (
        select(
            TopicCorrection,
            Item.id,
            Item.item_name,
            _changed_topic_codes("removed"),
            _changed_topic_codes("added"),
        )
        .outerjoin(Item, and_(Item.id == TopicCorrection.item_id, visible))
        .where(TopicCorrection.tenant_id == workspace_id)
    )


def _correction_record(workspace_id: UUID, row: Row[Any]) -> TopicCorrectionRecord:
    correction, item_id, title, removed, added = row
    return TopicCorrectionRecord(
        workspace_id=workspace_id,
        id=correction.id,
        item_id=item_id,
        item_display_name=title,
        from_topic_codes=tuple(removed or ()),
        to_topic_codes=tuple(added or ()),
        actor_id=correction.actor_user_id,
        state="open" if correction.dismissed_at is None else "dismissed",
        create_time=correction.created_at,
    )


async def _correction(
    session: AsyncSession, workspace_id: UUID, visible: ColumnElement[bool], correction_id: UUID
) -> TopicCorrectionRecord:
    row = (
        await session.execute(
            _corrections(workspace_id, visible).where(TopicCorrection.id == correction_id)
        )
    ).one_or_none()
    if row is None:
        raise NotFound(
            f"Resource '{topic_correction_name(workspace_id, correction_id)}' was not found."
        )
    return _correction_record(workspace_id, row)


async def _visible_items(ctx: RequestContext, workspace_id: UUID) -> ColumnElement[bool]:
    visibility = await item_visibility(ctx.authorizer, ctx.principal, workspace_id)
    return visibility.clause()


# -- Cross-slice API -----------------------------------------------------------------


async def assistant_topic_ids(session: AsyncSession, item_id: UUID) -> tuple[UUID, ...]:
    """The document's assistant-applied topics (``item_topics.created_by_user_id`` NULL)."""
    return tuple(
        await session.scalars(
            select(ItemTopic.topic_id).where(
                ItemTopic.item_id == item_id, ItemTopic.created_by_user_id.is_(None)
            )
        )
    )


async def suggested_topic_ids(session: AsyncSession, contribution_id: UUID) -> tuple[UUID, ...]:
    """The existing topics the contribution's analysis suggested."""
    return tuple(
        await session.scalars(
            select(ContributionTopic.topic_id).where(
                ContributionTopic.contribution_id == contribution_id,
                ContributionTopic.relation == "suggested",
            )
        )
    )


async def replace_classified_suggestions(
    session: AsyncSession,
    contribution: Contribution,
    topic_ids: Collection[UUID],
    summary: str | None,
    title: str | None,
) -> None:
    """Processing classified the candidate: its topics, summary and title replace
    the contribution's suggested ones, without confidences (``item_model.md`` §4.7).

    Only ACTIVE topics are kept; the contribution's ``etag`` changes.
    """
    await session.execute(
        delete(ContributionTopic).where(
            ContributionTopic.contribution_id == contribution.id,
            ContributionTopic.relation == "suggested",
        )
    )
    if topic_ids:
        await session.execute(
            pg_insert(ContributionTopic)
            .from_select(
                ["contribution_id", "topic_id", "relation"],
                select(literal(contribution.id, Uuid), Topic.id, literal("suggested")).where(
                    Topic.id.in_(list(topic_ids)),
                    Topic.state == "active",
                    Topic.deleted_at.is_(None),
                ),
            )
            .on_conflict_do_nothing()
        )
    suggestions = {
        key: value
        for key, value in (contribution.suggestions or {}).items()
        if key not in _CLASSIFIED_SUGGESTIONS
    }
    if summary:
        suggestions["summary"] = summary
    if title:
        suggestions["title"] = title
    contribution.suggestions = suggestions
    contribution.updated_at = func.now()
    await session.flush()


async def record_topic_correction(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    item_id: UUID,
    assistant_topic_ids: Collection[UUID],
    chosen_topic_ids: Collection[UUID],
    actor_user_id: UUID,
) -> None:
    """Record an OPEN TopicCorrection and its changed topics when the person's topics
    differ from the assistant's."""
    assistant = set(assistant_topic_ids)
    chosen = set(chosen_topic_ids)
    if assistant == chosen:
        return
    correction_id = await session.scalar(
        insert(TopicCorrection)
        .values(tenant_id=tenant_id, item_id=item_id, actor_user_id=actor_user_id)
        .returning(TopicCorrection.id)
    )
    await session.execute(
        insert(TopicCorrectionChange).values(
            [
                {"topic_correction_id": correction_id, "topic_id": topic_id, "change_type": kind}
                for kind, topic_ids in (("removed", assistant - chosen), ("added", chosen - assistant))
                for topic_id in topic_ids
            ]
        )
    )


__all__ = [
    "TopicAssignmentService",
    "assistant_topic_ids",
    "record_topic_correction",
    "replace_classified_suggestions",
]
