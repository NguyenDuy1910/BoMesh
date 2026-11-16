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

from collections.abc import Collection, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Uuid, delete, func, literal, select, update
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
#: The suggestions CLASSIFYING replaces: topics and summary, and their confidences.
_CLASSIFIED_SUGGESTIONS = frozenset(
    {"topics_confidence", "proposed_topics_confidence", "summary", "summary_confidence"}
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
        documents = select(Item.id).where(Item.item_type == "document", editable.clause(), where)
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
            correction = await _load(session, workspace_id, correction_id)
            return (await correction_records(session, workspace_id, visible, [correction]))[0]

    async def list_corrections(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[TopicCorrectionRecord], int]:
        await self._open(ctx, workspace_id, write=False)
        visible = await _visible_items(ctx, workspace_id)
        statement = select(TopicCorrection).where(TopicCorrection.tenant_id == workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            corrections = list(await session.scalars(query.apply(statement)))
            return await correction_records(session, workspace_id, visible, corrections), total

    async def dismiss_correction(
        self, ctx: RequestContext, workspace_id: UUID, correction_id: UUID
    ) -> TopicCorrectionRecord:
        """DismissTopicCorrection: OPEN → DISMISSED; an already DISMISSED one is unchanged."""
        await self._open(ctx, workspace_id, write=True)
        visible = await _visible_items(ctx, workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            correction = await _load(session, workspace_id, correction_id, for_update=True)
            if correction.state == "open":
                correction.state = "dismissed"
                await session.flush()
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="knowledge",
                    action="DismissTopicCorrection",
                    target=topic_correction_name(workspace_id, correction.id),
                )
            return (await correction_records(session, workspace_id, visible, [correction]))[0]

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


async def correction_records(
    session: AsyncSession,
    workspace_id: UUID,
    visible: ColumnElement[bool],
    corrections: Sequence[TopicCorrection],
) -> list[TopicCorrectionRecord]:
    """Records of ``corrections``; visible documents and topic codes load once for all."""
    item_ids = {correction.item_id for correction in corrections}
    titles: dict[UUID, str | None] = {}
    if item_ids:
        rows = await session.execute(
            select(Item.id, Item.title).where(Item.id.in_(item_ids), visible)
        )
        titles = dict(rows.tuples().all())
    topic_ids = {
        topic_id
        for correction in corrections
        for topic_id in (*correction.from_topic_ids, *correction.to_topic_ids)
    }
    codes: dict[UUID, str] = {}
    if topic_ids:
        found = await session.execute(select(Topic.id, Topic.code).where(Topic.id.in_(topic_ids)))
        codes = dict(found.tuples().all())

    def named(ids: Sequence[UUID]) -> tuple[str, ...]:
        return tuple(codes[topic_id] for topic_id in ids if topic_id in codes)

    return [
        TopicCorrectionRecord(
            workspace_id=workspace_id,
            id=correction.id,
            item_id=correction.item_id if correction.item_id in titles else None,
            item_display_name=titles.get(correction.item_id),
            from_topic_codes=named(correction.from_topic_ids),
            to_topic_codes=named(correction.to_topic_ids),
            actor_id=correction.actor_user_id,
            state=correction.state,
            create_time=correction.created_at,
        )
        for correction in corrections
    ]


async def _visible_items(ctx: RequestContext, workspace_id: UUID) -> ColumnElement[bool]:
    visibility = await item_visibility(ctx.authorizer, ctx.principal, workspace_id)
    return visibility.clause()


async def _load(
    session: AsyncSession, workspace_id: UUID, correction_id: UUID, *, for_update: bool = False
) -> TopicCorrection:
    statement = select(TopicCorrection).where(
        TopicCorrection.tenant_id == workspace_id, TopicCorrection.id == correction_id
    )
    if for_update:
        statement = statement.with_for_update()
    correction = await session.scalar(statement)
    if correction is None:
        raise NotFound(
            f"Resource '{topic_correction_name(workspace_id, correction_id)}' was not found."
        )
    return correction


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
) -> None:
    """Processing classified the candidate: its topics and summary replace the
    contribution's suggested ones, without confidences (``item_model.md`` §4.7).

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
    """Record an OPEN TopicCorrection when the person's topics differ from the assistant's."""
    assistant = set(assistant_topic_ids)
    chosen = set(chosen_topic_ids)
    if assistant == chosen:
        return
    session.add(
        TopicCorrection(
            tenant_id=tenant_id,
            item_id=item_id,
            from_topic_ids=[
                topic_id for topic_id in dict.fromkeys(assistant_topic_ids) if topic_id not in chosen
            ],
            to_topic_ids=[
                topic_id for topic_id in dict.fromkeys(chosen_topic_ids) if topic_id not in assistant
            ],
            actor_user_id=actor_user_id,
            state="open",
        )
    )
    await session.flush()


__all__ = [
    "TopicAssignmentService",
    "assistant_topic_ids",
    "correction_records",
    "record_topic_correction",
    "replace_classified_suggestions",
]
