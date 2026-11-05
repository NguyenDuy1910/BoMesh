"""Topics: the workspace taxonomy (DOMAIN and TOPIC) and its lifecycle.

PROPOSED → ACTIVE (accept) | REJECTED (reject); DELETED is ``deleted_at``
(delete only when unused, merge, undelete). Non-ACTIVE topics are seen only
by ``topics.accept`` holders. ``documentCount`` counts documents tagged with
the topic that the caller can see (the visibility rule: editors also count
unpublished ones); ListTopics sorts on that same per-caller count.
``inReviewCount`` is for reviewers only. Document tags are ``item_topics``:
KnowledgeItems writes a document's set (``tag_document``, validated by
:func:`resolve_active_topics`); this slice only retags them on merge.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    ColumnElement,
    Uuid,
    delete,
    distinct,
    func,
    literal,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Contribution, ContributionTopic, Item, ItemTopic, Topic
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.errors import AlreadyExists, FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import Authorizer, Principal, WorkspaceRef, permission_denied
from bomesh.iam.visibility import item_visibility
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import RETENTION, is_purged, purge_time
from bomesh.services.knowledge_curation.access import (
    is_any_reviewer,
    readable_clause,
    reviewer_clause,
)
from bomesh.services.knowledge_curation.queries import DOCUMENT_COUNT
from bomesh.services.knowledge_curation.records import (
    TopicDomainSummary,
    TopicDraft,
    TopicRecord,
    TopicSummary,
    topic_name,
)
from bomesh.services.knowledge_curation.support import CurationDeps, now

ACCEPT = "topics.accept"


class TopicService:
    def __init__(self, deps: CurationDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> TopicService:
        return cls(CurationDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        draft: TopicDraft,
        *,
        topic_id: str | None,
        request_id: UUID | None,
    ) -> TopicRecord:
        """CreateTopic: callers create ACTIVE topics (the assistant proposes PROPOSED ones)."""
        await self._open(ctx, workspace_id, "topics.create", write=True)
        if draft.kind == "domain" and draft.parent_code is not None:
            raise InvalidArgument.for_field("parentTopic", "A DOMAIN has no parentTopic.")
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateTopic",
                    parent=f"workspaces/{workspace_id}",
                    request=_fingerprint(draft, topic_id),
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    topic = await _load(session, workspace_id, replayed.rsplit("/", 1)[1])
                    return await topic_record(session, ctx.authorizer, ctx.principal, topic)
            code = topic_id or f"t{uuid4().hex[:12]}"
            if await _find(session, workspace_id, code) is not None:
                raise AlreadyExists(f"Topic '{topic_name(workspace_id, code)}' already exists.")
            parent_id = await _parent_id(session, workspace_id, draft.parent_code)
            topic = Topic(
                tenant_id=workspace_id,
                code=code,
                kind=draft.kind,
                parent_topic_id=parent_id,
                display_name=draft.display_name,
                description=draft.description,
                icon=draft.icon,
                color=draft.color,
                state="active",
                created_by_user_id=ctx.user_id,
            )
            session.add(topic)
            await session.flush()
            name = topic_name(workspace_id, code)
            await _audit(session, ctx, topic, "CreateTopic")
            if key is not None:
                await idempotency.remember(key, name)
            return await self._record(session, ctx, topic)

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> TopicRecord:
        await self._open(ctx, workspace_id, "topics.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await _load(session, workspace_id, code)
            await self._require_visible(ctx, topic, "topics.get")
            return await self._record(session, ctx, topic)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[TopicRecord], int]:
        await self._open(ctx, workspace_id, "topics.list", write=False)
        statement = select(Topic).where(Topic.tenant_id == workspace_id)
        if query.show_deleted:
            statement = statement.where(
                Topic.deleted_at.is_(None) | (Topic.deleted_at > func.now() - RETENTION)
            )
        else:
            statement = statement.where(Topic.deleted_at.is_(None))
        if not await self._may_accept(ctx, workspace_id):
            statement = statement.where(Topic.state == "active")
        visible = await _visible_documents(ctx.authorizer, ctx.principal, workspace_id)
        counted = statement.add_columns(_document_count(visible).label(DOCUMENT_COUNT.name))
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            topics = list(await session.scalars(query.apply(counted)))
            return [await self._record(session, ctx, topic) for topic in topics], total

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> TopicRecord:
        """UpdateTopic: ``changes`` keyed by mask path (``displayName``, ``parentTopic``, ...)."""
        await self._open(ctx, workspace_id, "topics.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await _load(session, workspace_id, code, for_update=True)
            await self._require_visible(ctx, topic, "topics.update")
            etags.check(etag, topic_etag(topic))
            for path, value in changes.items():
                match path:
                    case "displayName":
                        if not value:
                            raise InvalidArgument.for_field("displayName", "displayName is required.")
                        topic.display_name = value
                    case "description":
                        topic.description = value
                    case "icon":
                        topic.icon = value
                    case "color":
                        topic.color = value
                    case "parentTopic":
                        if topic.kind == "domain" and value:
                            raise InvalidArgument.for_field("parentTopic", "A DOMAIN has no parentTopic.")
                        topic.parent_topic_id = await _parent_id(session, workspace_id, value)
            await session.flush()
            await _audit(session, ctx, topic, "UpdateTopic")
            return await self._record(session, ctx, topic)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> TopicRecord:
        """DeleteTopic: only an unused topic (no document or contribution uses it)."""
        await self._open(ctx, workspace_id, "topics.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await _load(session, workspace_id, code, for_update=True)
            await self._require_visible(ctx, topic, "topics.delete")
            etags.check(etag, topic_etag(topic))
            if topic.deleted_at is not None:
                raise FailedPrecondition("The topic is already deleted.")
            if await _in_use(session, topic):
                raise FailedPrecondition("The topic is in use by documents, contributions or topics.")
            topic.deleted_at = await now(session)
            await session.flush()
            await _audit(session, ctx, topic, "DeleteTopic")
            return await self._record(session, ctx, topic)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> TopicRecord:
        await self._open(ctx, workspace_id, "topics.undelete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await _load(session, workspace_id, code, for_update=True)
            await self._require_visible(ctx, topic, "topics.undelete")
            etags.check(etag, topic_etag(topic))
            if topic.deleted_at is None:
                raise AlreadyExists("The topic is not deleted.")
            topic.deleted_at = None
            await session.flush()
            await _audit(session, ctx, topic, "UndeleteTopic")
            return await self._record(session, ctx, topic)

    async def accept(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        parent_code: str | None,
        display_name: str | None,
        etag: str | None,
    ) -> TopicRecord:
        """AcceptTopic: PROPOSED → ACTIVE; the contributions that proposed it now suggest it."""
        await self._open(ctx, workspace_id, ACCEPT, write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await self._transition(session, workspace_id, code, etag)
            if parent_code is not None:
                if topic.kind == "domain":
                    raise InvalidArgument.for_field("parentTopic", "A DOMAIN has no parentTopic.")
                topic.parent_topic_id = await _parent_id(session, workspace_id, parent_code)
            if display_name:
                topic.display_name = display_name
            topic.state = "active"
            await session.execute(
                update(ContributionTopic)
                .where(ContributionTopic.topic_id == topic.id, ContributionTopic.relation == "proposed")
                .values(relation="suggested")
            )
            await session.flush()
            await _audit(session, ctx, topic, "AcceptTopic")
            return await self._record(session, ctx, topic)

    async def reject(
        self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None
    ) -> TopicRecord:
        await self._open(ctx, workspace_id, "topics.reject", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await self._transition(session, workspace_id, code, etag)
            topic.state = "rejected"
            await session.flush()
            await _audit(session, ctx, topic, "RejectTopic")
            return await self._record(session, ctx, topic)

    async def merge(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        target_code: str,
        *,
        etag: str | None,
    ) -> TopicRecord:
        """MergeTopic: retag documents and contributions to the target, then delete this topic."""
        await self._open(ctx, workspace_id, "topics.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            topic = await _load(session, workspace_id, code, for_update=True)
            await self._require_visible(ctx, topic, "topics.update")
            etags.check(etag, topic_etag(topic))
            if topic.deleted_at is not None:
                raise FailedPrecondition("The topic is deleted.")
            target = await _find(session, workspace_id, target_code)
            if target is None:
                raise InvalidArgument.for_field(
                    "targetTopic", f"Topic '{topic_name(workspace_id, target_code)}' does not exist."
                )
            if target.id == topic.id or target.deleted_at is not None or target.kind != topic.kind:
                raise FailedPrecondition(
                    "The target topic must be another live topic of the same kind."
                )
            await _retag(session, topic.id, target.id)
            topic.deleted_at = await now(session)
            await session.flush()
            await _audit(session, ctx, topic, "MergeTopic")
            return await self._record(session, ctx, topic)

    # -- Internals -----------------------------------------------------------------

    async def _open(self, ctx: RequestContext, workspace_id: UUID, permission: str, *, write: bool) -> None:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), permission, write=write)

    async def _may_accept(self, ctx: RequestContext, workspace_id: UUID) -> bool:
        return ACCEPT in await ctx.authorizer.workspace_permissions(ctx.principal, workspace_id)

    async def _require_visible(self, ctx: RequestContext, topic: Topic, permission: str) -> None:
        if topic.state != "active" and not await self._may_accept(ctx, topic.tenant_id):
            raise permission_denied(permission, WorkspaceRef(topic.tenant_id))

    async def _transition(
        self, session: AsyncSession, workspace_id: UUID, code: str, etag: str | None
    ) -> Topic:
        topic = await _load(session, workspace_id, code, for_update=True)
        etags.check(etag, topic_etag(topic))
        if topic.state != "proposed" or topic.deleted_at is not None:
            raise FailedPrecondition(f"Only PROPOSED topics can change state; this one is {_state(topic)}.")
        return topic

    async def _record(self, session: AsyncSession, ctx: RequestContext, topic: Topic) -> TopicRecord:
        await session.refresh(topic)
        return await topic_record(session, ctx.authorizer, ctx.principal, topic)


# -- Records -------------------------------------------------------------------------


def topic_etag(topic: Topic) -> str:
    return etags.compute(topic_name(topic.tenant_id, topic.code), topic.updated_at)


async def topic_record(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, topic: Topic
) -> TopicRecord:
    workspace_id = topic.tenant_id
    parent_code = None
    if topic.parent_topic_id is not None:
        parent_code = await session.scalar(select(Topic.code).where(Topic.id == topic.parent_topic_id))
    evidence = await session.scalars(
        select(Contribution.id)
        .join(ContributionTopic, ContributionTopic.contribution_id == Contribution.id)
        .where(
            ContributionTopic.topic_id == topic.id,
            ContributionTopic.relation == "proposed",
            Contribution.deleted_at.is_(None),
            await readable_clause(authorizer, principal, workspace_id),
        )
        .order_by(Contribution.created_at, Contribution.id)
    )
    in_review = None
    if await is_any_reviewer(authorizer, principal, workspace_id):
        in_review = int(
            await session.scalar(
                select(func.count(distinct(Contribution.id)))
                .join(ContributionTopic, ContributionTopic.contribution_id == Contribution.id)
                .where(
                    ContributionTopic.topic_id == topic.id,
                    Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
                    Contribution.deleted_at.is_(None),
                    await reviewer_clause(authorizer, principal, workspace_id),
                )
            )
            or 0
        )
    counts = await document_counts(session, authorizer, principal, workspace_id, [topic.id])
    return TopicRecord(
        workspace_id=workspace_id,
        id=topic.id,
        code=topic.code,
        display_name=topic.display_name,
        description=topic.description,
        kind=topic.kind,
        parent_code=parent_code,
        icon=topic.icon,
        color=topic.color,
        state=_state(topic),
        evidence=tuple(evidence),
        document_count=counts.get(topic.id, 0),
        in_review_count=in_review,
        create_time=topic.created_at,
        update_time=topic.updated_at,
        delete_time=topic.deleted_at,
        purge_time=purge_time(topic.deleted_at),
        etag=topic_etag(topic),
    )


async def document_counts(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    topic_ids: Sequence[UUID],
) -> dict[UUID, int]:
    """Documents tagged with each topic that the caller can see."""
    if not topic_ids:
        return {}
    visible = await _visible_documents(authorizer, principal, workspace_id)
    rows = await session.execute(
        select(ItemTopic.topic_id, func.count())
        .join(Item, Item.id == ItemTopic.item_id)
        .where(ItemTopic.topic_id.in_(topic_ids), visible)
        .group_by(ItemTopic.topic_id)
    )
    return {topic_id: int(count) for topic_id, count in rows}


def _document_count(visible: ColumnElement[bool]) -> Any:
    """Correlated count of the visible documents tagged with the outer ``Topic``."""
    return (
        select(func.count())
        .select_from(ItemTopic)
        .join(Item, Item.id == ItemTopic.item_id)
        .where(ItemTopic.topic_id == Topic.id, visible)
        .correlate(Topic)
        .scalar_subquery()
    )


async def _visible_documents(
    authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> ColumnElement[bool]:
    visibility = await item_visibility(authorizer, principal, workspace_id)
    return visibility.clause()


def _state(topic: Topic) -> str:
    return "deleted" if topic.deleted_at is not None else topic.state


# -- Engine --------------------------------------------------------------------------


async def resolve_active_topics(
    session: AsyncSession, workspace_id: UUID, codes: Sequence[str], *, field: str = "topics"
) -> dict[str, UUID]:
    """ACTIVE, live topics by code; an unknown or inactive one is INVALID_ARGUMENT on ``field``.

    The validation behind KnowledgeItems' ``tag_document``.
    """
    topics = dict(
        (
            await session.execute(
                select(Topic.code, Topic.id).where(
                    Topic.tenant_id == workspace_id,
                    Topic.code.in_(codes),
                    Topic.state == "active",
                    Topic.deleted_at.is_(None),
                )
            )
        ).all()
    )
    missing = [code for code in codes if code not in topics]
    if missing:
        raise InvalidArgument.for_field(
            field, f"'{topic_name(workspace_id, missing[0])}' is not an ACTIVE topic."
        )
    return topics


async def _retag(session: AsyncSession, source_id: UUID, target_id: UUID) -> None:
    """Move ``item_topics`` and ``contribution_topics`` rows (deduplicated); reparent children."""
    await session.execute(
        insert(ItemTopic)
        .from_select(
            ["item_id", "topic_id", "created_by_user_id", "created_at"],
            select(
                ItemTopic.item_id,
                literal(target_id, Uuid),
                ItemTopic.created_by_user_id,
                ItemTopic.created_at,
            )
            .where(ItemTopic.topic_id == source_id),
        )
        .on_conflict_do_nothing()
    )
    await session.execute(delete(ItemTopic).where(ItemTopic.topic_id == source_id))
    await session.execute(
        insert(ContributionTopic)
        .from_select(
            ["contribution_id", "topic_id", "relation", "created_at"],
            select(
                ContributionTopic.contribution_id,
                literal(target_id, Uuid),
                ContributionTopic.relation,
                ContributionTopic.created_at,
            ).where(ContributionTopic.topic_id == source_id),
        )
        .on_conflict_do_nothing()
    )
    await session.execute(delete(ContributionTopic).where(ContributionTopic.topic_id == source_id))
    await session.execute(
        update(Topic).where(Topic.parent_topic_id == source_id).values(parent_topic_id=target_id)
    )


async def _in_use(session: AsyncSession, topic: Topic) -> bool:
    used = await session.scalar(
        select(
            select(ItemTopic.item_id).where(ItemTopic.topic_id == topic.id).exists()
            | select(ContributionTopic.contribution_id)
            .where(ContributionTopic.topic_id == topic.id)
            .exists()
            | select(Topic.id)
            .where(Topic.parent_topic_id == topic.id, Topic.deleted_at.is_(None))
            .exists()
        )
    )
    return bool(used)


async def _find(session: AsyncSession, workspace_id: UUID, code: str) -> Topic | None:
    return await session.scalar(
        select(Topic).where(Topic.tenant_id == workspace_id, Topic.code == code)
    )


async def _load(
    session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
) -> Topic:
    statement = select(Topic).where(Topic.tenant_id == workspace_id, Topic.code == code)
    if for_update:
        statement = statement.with_for_update()
    topic = await session.scalar(statement)
    if topic is None or is_purged(topic.deleted_at):
        raise NotFound(f"Resource '{topic_name(workspace_id, code)}' was not found.")
    return topic


async def _parent_id(session: AsyncSession, workspace_id: UUID, code: str | None) -> UUID | None:
    if not code:
        return None
    parent = await _find(session, workspace_id, code)
    if parent is None or parent.kind != "domain" or parent.deleted_at is not None:
        raise InvalidArgument.for_field(
            "parentTopic", f"'{topic_name(workspace_id, code)}' is not a live DOMAIN."
        )
    return parent.id


def _fingerprint(draft: TopicDraft, topic_id: str | None) -> dict[str, Any]:
    return {
        "topicId": topic_id,
        "displayName": draft.display_name,
        "kind": draft.kind,
        "description": draft.description,
        "parentTopic": draft.parent_code,
        "icon": draft.icon,
        "color": draft.color,
    }


async def _audit(session: AsyncSession, ctx: RequestContext, topic: Topic, action: str) -> None:
    await Audit(session).record(
        ctx,
        workspace_id=topic.tenant_id,
        category="knowledge",
        action=action,
        target=topic_name(topic.tenant_id, topic.code),
    )


# -- Cross-slice API -----------------------------------------------------------------


async def topic_summaries(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    limit: int,
) -> list[TopicDomainSummary]:
    """ACTIVE domains with their top ACTIVE topics; counts are documents the caller can see.

    A domain's count is the distinct documents tagged with it or any of its topics.
    """
    live = (Topic.tenant_id == workspace_id) & (Topic.state == "active") & Topic.deleted_at.is_(None)
    domains = list(await session.scalars(select(Topic).where(live, Topic.kind == "domain")))
    if not domains:
        return []
    children = list(
        await session.scalars(
            select(Topic).where(live, Topic.parent_topic_id.in_([d.id for d in domains]))
        )
    )
    counts = await document_counts(session, authorizer, principal, workspace_id, [t.id for t in children])
    visible = await _visible_documents(authorizer, principal, workspace_id)
    summaries = []
    for domain in domains:
        members = [domain.id] + [t.id for t in children if t.parent_topic_id == domain.id]
        total = await session.scalar(
            select(func.count(distinct(ItemTopic.item_id)))
            .join(Item, Item.id == ItemTopic.item_id)
            .where(ItemTopic.topic_id.in_(members), visible)
        )
        top = sorted(
            (
                TopicSummary(t.id, t.code, t.display_name, counts.get(t.id, 0))
                for t in children
                if t.parent_topic_id == domain.id
            ),
            key=lambda s: (-s.document_count, s.display_name),
        )[:5]
        summaries.append(
            TopicDomainSummary(domain.id, domain.code, domain.display_name, int(total or 0), top)
        )
    summaries.sort(key=lambda s: (-s.document_count, s.display_name))
    return summaries[:limit]


async def topic_count(session: AsyncSession, workspace_id: UUID) -> int:
    """ACTIVE topics (kind TOPIC) of the workspace."""
    count = await session.scalar(
        select(func.count()).where(
            Topic.tenant_id == workspace_id,
            Topic.kind == "topic",
            Topic.state == "active",
            Topic.deleted_at.is_(None),
        )
    )
    return int(count or 0)


__all__ = [
    "TopicService",
    "document_counts",
    "resolve_active_topics",
    "topic_count",
    "topic_etag",
    "topic_summaries",
]
