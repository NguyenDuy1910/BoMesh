"""Contributions: review of one candidate document (``item_model.md`` §4.7, §7).

State machine: ANALYZING → IN_REVIEW (system analysis); IN_REVIEW → APPROVED |
CHANGES_REQUESTED | REJECTED | WITHDRAWN; CHANGES_REQUESTED → ANALYZING
(resubmit) | WITHDRAWN. Approval moves/publishes the candidate or appends a
revision of the replaced document in one transaction and never starts an
ingestion run. While a contribution is open its candidate is frozen; that
check lives once, in the item engine (``has_open_contribution``).

Visibility: the contributor, and holders of ``contributions.review`` on the
decision collection (``targetCollection``; when empty, the suggested
collection, or the workspace). Timeline events are ``audit_logs`` rows of the
contribution (``details.event``).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    AuditLog,
    Contribution,
    ContributionTopic,
    IngestionSource,
    Item,
    Topic,
)
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    Principal,
    WorkspaceRef,
    permission_denied,
)
from bomesh.iam.policy import PERSONAL_KIND, PolicyStore, workspace_admins
from bomesh.iam.visibility import is_visible
from bomesh.services.ingestion.names import source_codes
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.notifications import (
    NotificationPublisher,
    NotificationSubject,
)
from bomesh.services.knowledge_curation.access import (
    REVIEW,
    is_reviewer,
    readable_clause,
    reviewer_clause,
    suggested_collection,
)
from bomesh.services.knowledge_curation.analysis import (
    ContributionAnalyzer,
    RuleAnalyzer,
)
from bomesh.services.knowledge_curation.records import (
    Approval,
    ContributionDraft,
    ContributionRecord,
    ContributionSummary,
    DecisionRecord,
    EventRecord,
    FlagRecord,
    SuggestionsRecord,
    contribution_name,
)
from bomesh.services.knowledge_curation.support import (
    CurationDeps,
    now,
    referenced_item,
)
from bomesh.services.knowledge_items.documents import set_document_metadata
from bomesh.services.knowledge_items.indexing import sync_item_payloads
from bomesh.services.knowledge_items.item_store import has_open_contribution
from bomesh.services.knowledge_items.items import (
    append_revision_from,
    delete_item,
    move_item,
    publish_item,
)

PUBLISH = "items.publish"
CLOSED_DELETABLE = ("rejected", "withdrawn")
REVIEWED_KIND = "contribution_reviewed"
SUBMITTED_KIND = "contribution_submitted"


class ContributionService:
    """Create, read, decide and close contributions."""

    def __init__(self, deps: CurationDeps, analyzer: ContributionAnalyzer | None = None) -> None:
        self._deps = deps
        self._analyzer = analyzer or RuleAnalyzer()

    @classmethod
    def from_runtime(cls, runtime: Any) -> ContributionService:
        return cls(CurationDeps.from_runtime(runtime))

    # -- Create and read -----------------------------------------------------------

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        draft: ContributionDraft,
        *,
        request_id: UUID | None,
    ) -> ContributionRecord:
        """CreateContribution: opens ANALYZING, analysis moves it to IN_REVIEW."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.create", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateContribution",
                    parent=f"workspaces/{workspace_id}",
                    request=_draft_fingerprint(draft),
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    return await self._record(
                        session, ctx, await _load(session, workspace_id, _id_of(replayed)), full=True
                    )
            candidate = await referenced_item(session, ctx, workspace_id, draft.item_id)
            await _require_candidate(session, ctx, candidate)
            target_id = await self._resolve_target(session, ctx, workspace_id, draft)
            contribution = Contribution(
                tenant_id=workspace_id,
                item_id=candidate.id,
                kind=draft.kind,
                origin="member",
                target_item_id=target_id,
                replaces_item_id=draft.replaces_id,
                contributor_user_id=ctx.user_id,
                note=draft.note,
                change_summary=draft.change_summary,
                state="analyzing",
            )
            session.add(contribution)
            await session.flush()
            name = contribution_name(workspace_id, contribution.id)
            await _event(session, ctx, contribution, "CreateContribution", "SUBMITTED", draft.note)
            await analyze_contribution(session, self._analyzer, contribution, candidate)
            await _notify_reviewers(session, ctx.authorizer, contribution, candidate.title)
            if key is not None:
                await idempotency.remember(key, name)
            return await self._record(session, ctx, contribution, full=True)

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, contribution_id: UUID, *, full: bool
    ) -> ContributionRecord:
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.get", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id)
            await self._require_reader(ctx, contribution, "contributions.get")
            return await self._record(session, ctx, contribution, full=full)

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        query: ListQuery,
        *,
        full: bool,
        referenced_collections: Iterable[UUID] = (),
    ) -> tuple[list[ContributionRecord], int]:
        """ListContributions: only contributions the caller made or may review."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.list", write=False
        )
        for collection_id in referenced_collections:
            if not await is_visible(
                ctx.authorizer, ctx.principal, ItemRef(workspace_id, collection_id)
            ):
                raise permission_denied("items.get", ItemRef(workspace_id, collection_id))
        readable = await readable_clause(ctx.authorizer, ctx.principal, workspace_id)
        statement = select(Contribution).where(
            Contribution.tenant_id == workspace_id,
            Contribution.deleted_at.is_(None),
            readable,
        )
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = list(await session.scalars(query.apply(statement)))
            return [await self._record(session, ctx, row, full=full) for row in rows], total

    # -- Contributor methods -------------------------------------------------------

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, contribution_id: UUID, *, etag: str | None
    ) -> None:
        """DeleteContribution: the contributor removes a REJECTED or WITHDRAWN one."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.delete", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id, for_update=True)
            await self._require_contributor(ctx, contribution, "contributions.delete")
            etags.check(etag, contribution_etag(contribution))
            if contribution.state not in CLOSED_DELETABLE:
                raise FailedPrecondition("Only REJECTED or WITHDRAWN contributions can be deleted.")
            contribution.deleted_at = await now(session)
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="DeleteContribution",
                target=contribution_name(workspace_id, contribution.id),
            )

    async def withdraw(
        self, ctx: RequestContext, workspace_id: UUID, contribution_id: UUID, *, etag: str | None
    ) -> ContributionRecord:
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.withdraw", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id, for_update=True)
            await self._require_contributor(ctx, contribution, "contributions.withdraw")
            etags.check(etag, contribution_etag(contribution))
            if contribution.origin == "source":
                raise FailedPrecondition("SOURCE contributions cannot be withdrawn.")
            _require_state(contribution, ("in_review", "changes_requested"), "withdraw")
            contribution.state = "withdrawn"
            await session.flush()
            await _event(session, ctx, contribution, "WithdrawContribution", "WITHDRAWN", None)
            return await self._record(session, ctx, contribution, full=True)

    async def resubmit(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        contribution_id: UUID,
        *,
        change_summary: str,
        item_id: UUID | None = None,
        note: str | None = None,
        etag: str | None = None,
    ) -> ContributionRecord:
        """ResubmitContribution: CHANGES_REQUESTED → ANALYZING → IN_REVIEW (new etag)."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.resubmit", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id, for_update=True)
            await self._require_contributor(ctx, contribution, "contributions.resubmit")
            etags.check(etag, contribution_etag(contribution))
            _require_state(contribution, ("changes_requested",), "resubmit")
            if item_id is not None and item_id != contribution.item_id:
                candidate = await referenced_item(session, ctx, workspace_id, item_id)
                await _require_candidate(session, ctx, candidate)
                contribution.item_id = candidate.id
            else:
                candidate = await session.get(Item, contribution.item_id)
                assert candidate is not None
                _require_available(candidate)
            contribution.change_summary = change_summary
            if note is not None:
                contribution.note = note
            contribution.state = "analyzing"
            await session.flush()
            await _event(
                session, ctx, contribution, "ResubmitContribution", "RESUBMITTED", change_summary
            )
            await analyze_contribution(session, self._analyzer, contribution, candidate)
            await _notify_reviewers(session, ctx.authorizer, contribution, candidate.title)
            return await self._record(session, ctx, contribution, full=True)

    # -- Reviewer methods ----------------------------------------------------------

    async def reject(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        contribution_id: UUID,
        *,
        message: str,
        etag: str | None,
    ) -> ContributionRecord:
        return await self._decide(
            ctx, workspace_id, contribution_id, "rejected", message, etag, "RejectContribution"
        )

    async def request_changes(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        contribution_id: UUID,
        *,
        message: str,
        etag: str | None,
    ) -> ContributionRecord:
        return await self._decide(
            ctx,
            workspace_id,
            contribution_id,
            "changes_requested",
            message,
            etag,
            "RequestContributionChanges",
        )

    async def approve(
        self, ctx: RequestContext, workspace_id: UUID, contribution_id: UUID, approval: Approval
    ) -> ContributionRecord:
        """ApproveContribution: publish (or revise) in one transaction; never ingests."""
        # contributions.review is collection-scoped: the decider check is on the contribution.
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.get", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id, for_update=True)
            if contribution.contributor_user_id != ctx.user_id and not await is_reviewer(
                ctx.authorizer, ctx.principal, contribution, include_deleted=True
            ):
                raise permission_denied(REVIEW, _contribution_ref(contribution))
            if not approval.etag:
                raise InvalidArgument.for_field("etag", "etag is required to approve.")
            target_id = await self._approval_target(session, ctx, contribution, approval)
            held = await ctx.authorizer.collection_permissions(ctx.principal, target_id)
            for permission in (REVIEW, PUBLISH):
                if permission not in held:
                    raise permission_denied(permission, ItemRef(workspace_id, target_id))
            etags.check(approval.etag, contribution_etag(contribution))
            _require_state(contribution, ("in_review",), "approve")
            candidate = await session.get(Item, contribution.item_id)
            assert candidate is not None
            _require_available(candidate)
            contribution.state = "approved"
            contribution.target_item_id = target_id
            contribution.decided_by_user_id = ctx.user_id
            contribution.decided_at = await now(session)
            await session.flush()
            published_id, dirty = await _apply_approval(session, ctx, contribution, target_id)
            await set_document_metadata(
                session,
                workspace_id,
                published_id,
                document_type=approval.document_type,
                summary=approval.summary,
                topics=approval.topic_codes,
                created_by_user_id=ctx.user_id,
            )
            await _event(session, ctx, contribution, "ApproveContribution", "APPROVED", None)
            await _notify_contributor(session, ctx.authorizer, contribution, "approved")
            record = await self._record(session, ctx, contribution, full=True)
        await sync_item_payloads(self._deps.sessions, self._deps.index, dirty)  # type: ignore[arg-type]
        return record

    # -- Internals -----------------------------------------------------------------

    async def _decide(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        contribution_id: UUID,
        state: str,
        message: str,
        etag: str | None,
        action: str,
    ) -> ContributionRecord:
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "contributions.get", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            contribution = await _load(session, workspace_id, contribution_id, for_update=True)
            if not await is_reviewer(ctx.authorizer, ctx.principal, contribution):
                raise permission_denied(REVIEW, _contribution_ref(contribution))
            etags.check(etag, contribution_etag(contribution))
            _require_state(contribution, ("in_review",), action)
            contribution.state = state
            contribution.decided_by_user_id = ctx.user_id
            contribution.decision_note = message
            contribution.decided_at = await now(session)
            await session.flush()
            await _event(session, ctx, contribution, action, state.upper(), message)
            await _notify_contributor(session, ctx.authorizer, contribution, state)
            return await self._record(session, ctx, contribution, full=True)

    async def _resolve_target(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, draft: ContributionDraft
    ) -> UUID | None:
        if draft.kind == "new_revision":
            if draft.replaces_id is None:
                raise InvalidArgument.for_field("replacesItem", "NEW_REVISION needs replacesItem.")
            replaced = await referenced_item(session, ctx, workspace_id, draft.replaces_id)
            if replaced.item_type != "document" or replaced.publication_state != "published":
                raise InvalidArgument.for_field(
                    "replacesItem", "replacesItem must be a published DOCUMENT."
                )
            governing = await ctx.authorizer.governing_collection(replaced.id)
            if draft.target_id is not None and draft.target_id != governing:
                raise InvalidArgument.for_field(
                    "targetCollection",
                    "A NEW_REVISION targets the governing collection of replacesItem.",
                )
            return governing
        if draft.replaces_id is not None:
            raise InvalidArgument.for_field("replacesItem", "replacesItem is for NEW_REVISION only.")
        if draft.target_id is None:
            return None
        target = await referenced_item(session, ctx, workspace_id, draft.target_id)
        if target.item_type != "collection":
            raise InvalidArgument.for_field("targetCollection", "targetCollection must be a COLLECTION.")
        if target.metadata_.get("accepts_contributions") is not True:
            raise FailedPrecondition("The target collection does not accept contributions.")
        return target.id

    async def _approval_target(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        contribution: Contribution,
        approval: Approval,
    ) -> UUID:
        workspace_id = contribution.tenant_id
        if contribution.kind == "new_revision":
            assert contribution.replaces_item_id is not None
            await _require_live(ctx, contribution.replaces_item_id, "The replaced document")
            governing = await ctx.authorizer.governing_collection(contribution.replaces_item_id)
            if approval.target_id is not None and approval.target_id != (
                contribution.target_item_id
            ):
                raise InvalidArgument.for_field(
                    "targetCollection",
                    "A NEW_REVISION targets the governing collection of replacesItem.",
                )
            if governing != contribution.target_item_id:
                raise FailedPrecondition(
                    "The replaced document moved since the contribution was created.",
                    reason="TARGET_MOVED",
                )
            return governing
        target_id = approval.target_id or contribution.target_item_id
        if target_id is None:
            raise InvalidArgument.for_field(
                "targetCollection", "targetCollection is required: the contribution has none."
            )
        await _require_live(ctx, target_id, "The target collection")
        if approval.target_id is not None:
            target = await referenced_item(session, ctx, workspace_id, target_id)
            if target.item_type != "collection":
                raise InvalidArgument.for_field(
                    "targetCollection", "targetCollection must be a COLLECTION."
                )
        return target_id

    async def _require_reader(
        self, ctx: RequestContext, contribution: Contribution, permission: str
    ) -> None:
        if contribution.contributor_user_id == ctx.user_id:
            return
        if not await is_reviewer(ctx.authorizer, ctx.principal, contribution):
            raise permission_denied(permission, _contribution_ref(contribution))

    async def _require_contributor(
        self, ctx: RequestContext, contribution: Contribution, permission: str
    ) -> None:
        if contribution.contributor_user_id != ctx.user_id:
            raise permission_denied(permission, _contribution_ref(contribution))

    async def _record(
        self, session: AsyncSession, ctx: RequestContext, contribution: Contribution, *, full: bool
    ) -> ContributionRecord:
        await session.refresh(contribution)
        return await contribution_record(
            session, ctx.authorizer, ctx.principal, contribution, full=full
        )


# -- Records -------------------------------------------------------------------------


def contribution_etag(contribution: Contribution) -> str:
    return etags.compute(
        contribution_name(contribution.tenant_id, contribution.id), contribution.updated_at
    )


async def contribution_record(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    contribution: Contribution,
    *,
    full: bool,
) -> ContributionRecord:
    workspace_id = contribution.tenant_id
    topics = await session.execute(
        select(Topic.code, ContributionTopic.relation)
        .join(Topic, Topic.id == ContributionTopic.topic_id)
        .where(ContributionTopic.contribution_id == contribution.id)
        .order_by(Topic.code)
    )
    suggested: list[str] = []
    proposed: list[str] = []
    for code, relation in topics:
        (proposed if relation == "proposed" else suggested).append(code)
    flags = []
    for flag in contribution.flags or []:
        related = flag.get("related_item_id")
        related_id = UUID(related) if related else None
        if related_id is not None and not await is_visible(
            authorizer, principal, ItemRef(workspace_id, related_id)
        ):
            related_id = None
        flags.append(FlagRecord(kind=flag["flag"], related_item_id=related_id))
    source_code = None
    if contribution.ingestion_source_id is not None:
        codes = await source_codes(session, [contribution.ingestion_source_id])
        source_code = codes.get(contribution.ingestion_source_id)
    values = contribution.suggestions or {}
    decision = None
    if contribution.decided_at is not None:
        decision = DecisionRecord(
            reviewer_id=contribution.decided_by_user_id,
            message=contribution.decision_note,
            decide_time=contribution.decided_at,
        )
    return ContributionRecord(
        workspace_id=workspace_id,
        id=contribution.id,
        kind=contribution.kind,
        origin=contribution.origin,
        item_id=contribution.item_id,
        target_id=contribution.target_item_id,
        replaces_id=contribution.replaces_item_id,
        contributor_id=contribution.contributor_user_id,
        source_code=source_code,
        external_version=contribution.external_version,
        note=contribution.note,
        change_summary=contribution.change_summary,
        suggestions=SuggestionsRecord(
            document_type=values.get("document_type"),
            document_type_confidence=values.get("document_type_confidence"),
            topic_codes=tuple(suggested),
            topics_confidence=values.get("topics_confidence"),
            proposed_topic_codes=tuple(proposed),
            proposed_topics_confidence=values.get("proposed_topics_confidence"),
            collection_id=suggested_collection(contribution),
            collection_confidence=values.get("collection_confidence"),
            summary=values.get("summary"),
            summary_confidence=values.get("summary_confidence"),
        ),
        flags=tuple(flags),
        audience_summary=await _audience_summary(session, contribution),
        state=contribution.state,
        decision=decision,
        events=await _events(session, contribution) if full else None,
        create_time=contribution.created_at,
        update_time=contribution.updated_at,
        etag=contribution_etag(contribution),
    )


async def _audience_summary(session: AsyncSession, contribution: Contribution) -> str | None:
    if contribution.target_item_id is None:
        return None
    title = await session.scalar(select(Item.title).where(Item.id == contribution.target_item_id))
    return f"Readers of {title}" if title else None


async def _events(session: AsyncSession, contribution: Contribution) -> tuple[EventRecord, ...]:
    rows = await session.scalars(
        select(AuditLog)
        .where(
            AuditLog.tenant_id == contribution.tenant_id,
            AuditLog.target_name == contribution_name(contribution.tenant_id, contribution.id),
            AuditLog.details["event"].astext.is_not(None),
        )
        .order_by(AuditLog.created_at)
    )
    events = [
        EventRecord(
            kind=row.details["event"],
            actor_id=row.actor_user_id,
            message=row.details.get("message"),
            create_time=row.created_at,
        )
        for row in rows
    ]
    # One transaction stamps its events with one time; ANALYZED follows the submission.
    events.sort(key=lambda event: (event.create_time, event.kind == "ANALYZED"))
    return tuple(events)


# -- Helpers -------------------------------------------------------------------------


async def _load(
    session: AsyncSession, workspace_id: UUID, contribution_id: UUID, *, for_update: bool = False
) -> Contribution:
    statement = select(Contribution).where(
        Contribution.id == contribution_id,
        Contribution.tenant_id == workspace_id,
        Contribution.deleted_at.is_(None),
    )
    if for_update:
        statement = statement.with_for_update()
    contribution = await session.scalar(statement)
    if contribution is None:
        raise NotFound(
            f"Resource '{contribution_name(workspace_id, contribution_id)}' was not found."
        )
    return contribution


def _contribution_ref(contribution: Contribution) -> WorkspaceRef:
    """The workspace scope of contribution permissions (they are workspace-scoped)."""
    return WorkspaceRef(contribution.tenant_id)


def _id_of(name: str) -> UUID:
    return UUID(name.rsplit("/", 1)[1])


def _draft_fingerprint(draft: ContributionDraft) -> dict[str, Any]:
    return {
        "kind": draft.kind,
        "item": draft.item_id,
        "targetCollection": draft.target_id,
        "replacesItem": draft.replaces_id,
        "note": draft.note,
        "changeSummary": draft.change_summary,
    }


def _require_state(contribution: Contribution, allowed: Sequence[str], verb: str) -> None:
    if contribution.state not in allowed:
        raise FailedPrecondition(
            f"Cannot {verb} a {contribution.state.upper()} contribution."
        )


def _require_available(candidate: Item) -> None:
    if (
        candidate.item_type != "document"
        or candidate.deleted_at is not None
        or candidate.status != "ready"
    ):
        raise FailedPrecondition(
            "The candidate must be an ACTIVE document with contentState AVAILABLE."
        )


async def _require_candidate(session: AsyncSession, ctx: RequestContext, candidate: Item) -> None:
    """A member's candidate: available, in the caller's PERSONAL collection, not under review."""
    if candidate.item_type != "document":
        raise InvalidArgument.for_field("item", "The candidate must be a DOCUMENT.")
    _require_available(candidate)
    parent = (
        await session.get(Item, candidate.parent_item_id) if candidate.parent_item_id else None
    )
    if (
        parent is None
        or parent.metadata_.get("system_kind") != PERSONAL_KIND
        or parent.created_by_user_id != ctx.user_id
    ):
        raise FailedPrecondition("The candidate must be in your PERSONAL collection.")
    if await has_open_contribution(session, candidate.id):
        raise FailedPrecondition(
            "This document is already under review.", reason="CONTRIBUTION_OPEN"
        )


async def _apply_approval(
    session: AsyncSession, ctx: RequestContext, contribution: Contribution, target_id: UUID
) -> tuple[UUID, tuple[UUID, ...]]:
    """The approval effect; returns the published document and the dirty index payloads."""
    workspace_id = contribution.tenant_id
    if contribution.kind == "new_revision":
        assert contribution.replaces_item_id is not None
        await append_revision_from(
            session,
            contribution.item_id,
            contribution.replaces_item_id,
            contribution.id,
            created_by_user_id=ctx.user_id,
            summary=contribution.change_summary,
        )
        dirty = await delete_item(session, workspace_id, contribution.item_id)
        return contribution.replaces_item_id, (contribution.replaces_item_id, *dirty)
    dirty: tuple[UUID, ...] = ()
    if contribution.origin == "member":
        dirty = await move_item(session, workspace_id, contribution.item_id, target_id)
    dirty = (*dirty, *await publish_item(session, workspace_id, contribution.item_id))
    return contribution.item_id, dirty


async def _require_live(ctx: RequestContext, item_id: UUID, what: str) -> None:
    """FAILED_PRECONDITION ``TARGET_DELETED`` when the item or an ancestor is deleted."""
    path = await ctx.authorizer.ancestry(item_id)
    if not path or any(node.deleted_at is not None for node in path):
        raise FailedPrecondition(f"{what} was deleted.", reason="TARGET_DELETED")


async def _event(
    session: AsyncSession,
    ctx: RequestContext | None,
    contribution: Contribution,
    action: str,
    event: str,
    message: str | None,
) -> None:
    details: dict[str, Any] = {"event": event}
    if message:
        details["message"] = message
    await Audit(session).record(
        ctx,
        workspace_id=contribution.tenant_id,
        category="knowledge",
        action=action,
        target=contribution_name(contribution.tenant_id, contribution.id),
        details=details,
    )


async def _notify_contributor(
    session: AsyncSession, authorizer: Authorizer, contribution: Contribution, state: str
) -> None:
    contributor = contribution.contributor_user_id
    if contributor is None:
        return

    async def is_contributor(principal: Principal) -> bool:
        return principal.user_id == contributor

    await NotificationPublisher(session, authorizer).publish(
        workspace_id=contribution.tenant_id,
        recipients=[contributor],
        kind=REVIEWED_KIND,
        title=f"Your contribution was {state.replace('_', ' ')}",
        body=contribution.decision_note or "",
        subject=NotificationSubject("contribution", contribution.id),
        can_read=is_contributor,
    )


async def _notify_reviewers(
    session: AsyncSession, authorizer: Authorizer, contribution: Contribution, title: str
) -> None:
    """Workspace admins and the users bound directly on the decision collection's chain."""
    candidates = set(await workspace_admins(session, contribution.tenant_id))
    collection_id = contribution.target_item_id or suggested_collection(contribution)
    if collection_id is not None:
        store = PolicyStore(session, authorizer)
        for node in await authorizer.ancestry(collection_id):
            if node.item_type != "collection":
                continue
            policy = await store.get_policy(ItemRef(contribution.tenant_id, node.item_id))
            for binding in policy.bindings:
                candidates.update(
                    UUID(member.removeprefix("user:"))
                    for member in binding.members
                    if member.startswith("user:")
                )
    candidates.discard(contribution.contributor_user_id)  # type: ignore[arg-type]

    async def reviews(principal: Principal) -> bool:
        return await is_reviewer(authorizer, principal, contribution)

    await NotificationPublisher(session, authorizer).publish(
        workspace_id=contribution.tenant_id,
        recipients=sorted(candidates),
        kind=SUBMITTED_KIND,
        title="A contribution is waiting for review",
        body=title,
        subject=NotificationSubject("contribution", contribution.id),
        can_read=reviews,
    )


# -- Cross-slice API -----------------------------------------------------------------


async def open_source_contribution(
    session: AsyncSession,
    *,
    source: IngestionSource,
    item: Item,
    kind: str,
    target_item_id: UUID,
    replaces_item_id: UUID | None = None,
    external_version: str | None = None,
) -> Contribution:
    """Open (or return the existing) SOURCE contribution of a REVIEW_FIRST source sync.

    ``kind`` ``new_document``: ``item`` is the new UNPUBLISHED document in the
    target collection. ``new_revision``: ``item`` is the candidate holding
    ``external_version`` of ``replaces_item_id``; ``target_item_id`` is that
    document's governing collection. One contribution per
    ``(replaces_item_id, external_version)``, whatever its state. The
    contribution is analyzed like a member's and opens IN_REVIEW. Runs in the
    sync's transaction; nobody to authorize.
    """
    if kind == "new_revision":
        existing = await source_revision_contribution(
            session, source.id, replaces_item_id, external_version
        )
        if existing is not None:
            return existing
    contribution = Contribution(
        tenant_id=source.tenant_id,
        item_id=item.id,
        kind=kind,
        origin="source",
        ingestion_source_id=source.id,
        target_item_id=target_item_id,
        replaces_item_id=replaces_item_id,
        external_version=external_version,
        state="analyzing",
    )
    session.add(contribution)
    await session.flush()
    await _event(session, None, contribution, "CreateContribution", "SUBMITTED", None)
    await analyze_contribution(session, RuleAnalyzer(), contribution, item)
    return contribution


async def analyze_contribution(
    session: AsyncSession,
    analyzer: ContributionAnalyzer,
    contribution: Contribution,
    candidate: Item,
) -> None:
    """The system step ANALYZING → IN_REVIEW: suggestions, flags and suggested topics."""
    analysis = await analyzer.analyze(
        session,
        candidate,
        kind=contribution.kind,
        replaces_item_id=contribution.replaces_item_id,
        note=contribution.note,
    )
    contribution.suggestions = analysis.suggestions()
    contribution.flags = [
        {
            "flag": flag.kind,
            "related_item_id": str(flag.related_item_id) if flag.related_item_id else None,
        }
        for flag in analysis.flags
    ]
    await session.execute(
        delete(ContributionTopic).where(
            ContributionTopic.contribution_id == contribution.id,
            ContributionTopic.relation == "suggested",
        )
    )
    for topic_id in analysis.topic_ids:
        session.add(
            ContributionTopic(
                contribution_id=contribution.id, topic_id=topic_id, relation="suggested"
            )
        )
    contribution.state = "in_review"
    await session.flush()
    await _event(session, None, contribution, "AnalyzeContribution", "ANALYZED", None)


async def source_revision_contribution(
    session: AsyncSession,
    source_id: UUID,
    replaces_item_id: UUID | None,
    external_version: str | None,
) -> Contribution | None:
    """The SOURCE NEW_REVISION contribution of this provider version, in any state."""
    return await session.scalar(
        select(Contribution).where(
            Contribution.ingestion_source_id == source_id,
            Contribution.kind == "new_revision",
            Contribution.replaces_item_id == replaces_item_id,
            Contribution.external_version.is_not_distinct_from(external_version),
            Contribution.deleted_at.is_(None),
        )
    )


async def contribution_readable(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    contribution_id: UUID,
) -> bool:
    """Whether a notification about the contribution may still be shown to ``principal``.

    The contributor always (until they delete it); a reviewer only while it is
    OPEN and they still hold ``contributions.review`` on its decision collection.
    A missing or deleted contribution is never readable.
    """
    contribution = await session.scalar(
        select(Contribution).where(
            Contribution.id == contribution_id,
            Contribution.tenant_id == workspace_id,
            Contribution.deleted_at.is_(None),
        )
    )
    if contribution is None:
        return False
    if contribution.contributor_user_id == principal.user_id:
        return True
    return contribution.state in OPEN_CONTRIBUTION_STATES and await is_reviewer(
        authorizer, principal, contribution
    )


async def review_queue_count(
    session: AsyncSession, authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> int:
    """IN_REVIEW contributions the caller may decide."""
    reviewable = await reviewer_clause(authorizer, principal, workspace_id)
    count = await session.scalar(
        select(func.count()).where(
            Contribution.tenant_id == workspace_id,
            Contribution.state == "in_review",
            Contribution.deleted_at.is_(None),
            reviewable,
        )
    )
    return int(count or 0)


async def member_contributions(
    session: AsyncSession, workspace_id: UUID, user_id: UUID, *, limit: int
) -> list[ContributionSummary]:
    """A member's open contributions, newest first, named after their candidate."""
    rows = await session.execute(
        select(Contribution.id, Item.title, Contribution.state)
        .join(Item, Item.id == Contribution.item_id)
        .where(
            Contribution.tenant_id == workspace_id,
            Contribution.contributor_user_id == user_id,
            Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
            Contribution.deleted_at.is_(None),
        )
        .order_by(Contribution.created_at.desc(), Contribution.id)
        .limit(limit)
    )
    return [
        ContributionSummary(contribution_id=cid, display_name=title, state=state.upper())
        for cid, title, state in rows
    ]


__all__ = [
    "ContributionService",
    "contribution_etag",
    "contribution_readable",
    "member_contributions",
    "open_source_contribution",
    "review_queue_count",
    "source_revision_contribution",
]
