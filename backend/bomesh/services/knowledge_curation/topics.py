"""Topics: the workspace taxonomy (DOMAIN and TOPIC) and its lifecycle.

PROPOSED → ACTIVE (accept) | REJECTED (reject); DELETED is ``deleted_at``
(delete only when unused, merge, undelete). Non-ACTIVE topics are seen only
by ``topics.accept`` holders. ``documentCount`` counts documents tagged with
the topic that the caller can see (the visibility rule: editors also count
unpublished ones); ListTopics sorts on that same per-caller count.
``inReviewCount`` is for reviewers only. Document tags are ``item_topics``:
KnowledgeItems writes a document's set (``tag_document``, validated by
:func:`resolve_active_topics`); this slice only retags them on merge.

A TOPIC's classification signals (keywords, synonyms, guidance, examples,
rules) feed CLASSIFYING: :func:`classification_candidates` is the one
candidate load of ingestion runs, TestTopicClassification and the compiled
prompt.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    ColumnElement,
    Select,
    Uuid,
    and_,
    delete,
    distinct,
    func,
    literal,
    or_,
    select,
    tuple_,
    update,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import (
    Contribution,
    ContributionTopic,
    IngestionSource,
    Item,
    ItemRevision,
    ItemTopic,
    Topic,
)
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.document_index import (
    ClassificationRequest,
    TopicCandidate,
    classification_prompt,
)
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    Unavailable,
)
from bomesh.iam.authorizer import (
    Authorizer,
    ItemRef,
    Principal,
    WorkspaceRef,
    item_ancestry,
    permission_denied,
)
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
    SIGNAL_PATHS,
    TopicClassificationPrompt,
    TopicClassificationTest,
    TopicDomainSummary,
    TopicDraft,
    TopicImportChange,
    TopicImportResult,
    TopicImportRow,
    TopicRecord,
    TopicRule,
    TopicSignals,
    TopicSummary,
    parse_topic,
    topic_name,
)
from bomesh.services.knowledge_curation.support import (
    CurationDeps,
    now,
    referenced_item,
)

ACCEPT = "topics.accept"
MAX_TERMS = 50
MAX_TERM_LENGTH = 100
MAX_GUIDANCE = 2000
MAX_EXAMPLES = 5
MAX_RULES = 20
MAX_DISPLAY_NAME = 255
#: A topic's ``icon`` is an icon name; its ``color`` is ``#RRGGBB`` (stored lowercase).
_ICON = re.compile(r"[a-z][a-z0-9-]{0,63}")
_COLOR = re.compile(r"#[0-9a-f]{6}")
#: Placeholders of the compiled prompt (CompileTopicClassificationPrompt).
_PROMPT_NOTE = "[the run's note for the assistant]"
_PROMPT_TITLE = "[document title]"
_PROMPT_DOCUMENT = "[document metadata and leading excerpts, up to 12,000 characters]"
_PROMPT_MATCHES = "[topics whose name, keywords or synonyms occur in the document]"


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
        icon, color = _icon(draft.icon), _color(draft.color)
        if draft.kind == "domain" and draft.signals != TopicSignals():
            raise InvalidArgument.for_field(
                "keywords", "A DOMAIN has no keywords, synonyms, guidance, examples or rules."
            )
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
            code = topic_id or _generated_code()
            if await _find(session, workspace_id, code) is not None:
                raise AlreadyExists(f"Topic '{topic_name(workspace_id, code)}' already exists.")
            parent_id = await _parent_id(session, workspace_id, draft.parent_code)
            signals = await _validated_signals(
                session, ctx, workspace_id, draft.kind, _signal_values(draft.signals)
            )
            topic = Topic(
                tenant_id=workspace_id,
                code=code,
                kind=draft.kind,
                parent_topic_id=parent_id,
                topic_name=draft.display_name,
                description=draft.description,
                icon=icon,
                color=color,
                state="active",
                created_by_user_id=ctx.user_id,
            )
            _set_signals(topic, signals)
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
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery, *, full: bool
    ) -> tuple[list[TopicRecord], int]:
        """``full`` (view FULL) adds the Studio fields: signals, evidence and ``inReviewCount``."""
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
        tagged = _tagged_counts(visible).subquery("topic_document_counts")
        counted = statement.outerjoin(tagged, tagged.c.topic_id == Topic.id).add_columns(
            func.coalesce(tagged.c.document_count, 0).label(DOCUMENT_COUNT.name)
        )
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = (await session.execute(query.apply(counted))).tuples().all()
            records = await topic_records(
                session,
                ctx.authorizer,
                ctx.principal,
                [topic for topic, _ in rows],
                full=full,
                counts={topic.id: int(count) for topic, count in rows},
            )
            return records, total

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> TopicRecord:
        """UpdateTopic: ``changes`` keyed by mask path (``displayName``, ``parentTopic``,
        ``keywords``, ...; ``examples`` are item IDs, ``rules`` :class:`TopicRule`)."""
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
                        topic.topic_name = value
                    case "description":
                        topic.description = value
                    case "icon":
                        topic.icon = _icon(value)
                    case "color":
                        topic.color = _color(value)
                    case "parentTopic":
                        if topic.kind == "domain" and value:
                            raise InvalidArgument.for_field("parentTopic", "A DOMAIN has no parentTopic.")
                        topic.parent_topic_id = await _parent_id(session, workspace_id, value)
            signal_changes = {path: changes[path] for path in SIGNAL_PATHS if path in changes}
            if signal_changes:
                _set_signals(
                    topic,
                    await _validated_signals(
                        session,
                        ctx,
                        workspace_id,
                        topic.kind,
                        signal_changes,
                        current=_topic_signals(topic),
                    ),
                )
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
                topic.topic_name = display_name
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

    async def import_topics(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        rows: Sequence[TopicImportRow],
        *,
        replace: bool,
        validate_only: bool,
    ) -> TopicImportResult:
        """ImportTopics: create and update topics from rows in one transaction.

        Rows name domains and topics by display name (:func:`_plan_import`); a
        row that cannot apply is skipped with its reason. REPLACE also archives
        the ACTIVE topics no row matched, unless in use. The outcome is computed
        in memory; ``validateOnly`` stops there (no write, no row lock), a real
        import then writes it in a few set-based statements.
        """
        await self._open(ctx, workspace_id, "topics.update", write=True)
        granted = await ctx.authorizer.workspace_permissions(ctx.principal, workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            statement = select(Topic).where(Topic.tenant_id == workspace_id)
            if not validate_only:
                statement = statement.with_for_update()
            existing = {topic.code: topic for topic in await session.scalars(statement)}
            plan = _plan_import(workspace_id, rows, existing)
            if plan.new and "topics.create" not in granted:
                raise permission_denied("topics.create", WorkspaceRef(workspace_id))
            unchanged = plan.unchanged
            archived: list[Topic] = []
            if replace:
                # Topics before domains: a domain is in use while it has live topics.
                missing = sorted(
                    (
                        topic
                        for topic in existing.values()
                        if topic.code not in plan.matched
                        and topic.state == "active"
                        and topic.deleted_at is None
                    ),
                    key=lambda topic: (topic.kind == "domain", topic.code),
                )
                tagged = await _tagged(session, [topic.id for topic in missing])
                parents = plan.parents
                children = Counter(parent for parent in parents.values() if parent is not None)
                for topic in missing:
                    if topic.id in tagged or children[topic.code]:
                        unchanged += 1
                        continue
                    if "topics.delete" not in granted:
                        raise permission_denied("topics.delete", WorkspaceRef(workspace_id))
                    archived.append(topic)
                    if (parent := parents.pop(topic.code)) is not None:
                        children[parent] -= 1
            # Before applying: the result reports the names an update replaces.
            result = _import_result(existing, plan, archived, unchanged)
            if not validate_only:
                await _apply_import(session, ctx, workspace_id, existing, plan, archived)
                if plan.new or plan.changes or archived:
                    await Audit(session).record(
                        ctx,
                        workspace_id=workspace_id,
                        category="knowledge",
                        action="ImportTopics",
                        target=f"workspaces/{workspace_id}",
                    )
            return result

    async def test_classification(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        title: str,
        text: str,
        collection_id: UUID | None,
        source_code: str | None,
        overrides: Mapping[str, Mapping[str, Any]],
    ) -> TopicClassificationTest:
        """TestTopicClassification: CLASSIFYING of a sample, with unsaved topic changes.

        ``overrides`` maps a topic code to changes keyed like UpdateTopic's
        (``displayName``, ``description`` and the signal paths).
        """
        await self._open(ctx, workspace_id, "topics.update", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            changed: dict[str, tuple[str, str | None, TopicSignals]] = {}
            if overrides:
                topics = {
                    topic.code: topic
                    for topic in await session.scalars(
                        select(Topic).where(
                            Topic.tenant_id == workspace_id,
                            Topic.code.in_(list(overrides)),
                            Topic.state == "active",
                            Topic.deleted_at.is_(None),
                        )
                    )
                }
                for code, values in overrides.items():
                    topic = topics.get(code)
                    if topic is None:
                        raise InvalidArgument.for_field(
                            "topics", f"'{topic_name(workspace_id, code)}' is not an ACTIVE topic."
                        )
                    changed[code] = (
                        values.get("displayName") or topic.topic_name,
                        values["description"] if "description" in values else topic.description,
                        await _validated_signals(
                            session,
                            ctx,
                            workspace_id,
                            topic.kind,
                            {path: values[path] for path in SIGNAL_PATHS if path in values},
                            current=_topic_signals(topic),
                        ),
                    )
            candidates = await classification_candidates(session, workspace_id, overrides=changed)
            ancestors: tuple[str, ...] = ()
            if collection_id is not None:
                collection = await referenced_item(session, ctx, workspace_id, collection_id)
                if collection.item_kind != "collection":
                    raise InvalidArgument.for_field("collection", "collection must be a COLLECTION item.")
                ancestors = tuple(
                    str(node.item_id) for node in await item_ancestry(session, collection_id)
                )
        if not candidates:
            return TopicClassificationTest(results=(), summary=None)
        request = ClassificationRequest(candidates).for_document(ancestors, source_code)
        try:
            classified = await self._deps.index.classify_sample(
                title=title, text=text, request=request
            )
        except Exception as exc:
            raise Unavailable("The classification model did not answer; try again.") from exc
        if classified is None:
            raise FailedPrecondition(
                "No rule matches and the contextualization model is not configured."
            )
        reason = "rule" if request.settled else "assistant"
        return TopicClassificationTest(
            results=tuple((topic.code, reason) for topic in classified.topics),
            summary=classified.summary,
        )

    async def compile_classification_prompt(
        self, ctx: RequestContext, workspace_id: UUID
    ) -> TopicClassificationPrompt:
        """CompileTopicClassificationPrompt: the ``document_profile`` prompt over every
        ACTIVE topic with placeholders — the prefix every document shares (cached),
        then one document's part — and the rules checked before it."""
        await self._open(ctx, workspace_id, "topics.update", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            candidates = await classification_candidates(session, workspace_id)
        compiled = classification_prompt(ClassificationRequest(candidates, note=_PROMPT_NOTE))
        prompt = "\n\n".join(
            (
                compiled.prefix,
                compiled.document(
                    title=_PROMPT_TITLE, document_context=_PROMPT_DOCUMENT, matches=_PROMPT_MATCHES
                ),
            )
        )
        rules = tuple(
            (candidate.code, rule)
            for candidate in candidates
            for rule in (
                *(TopicRule(collection_id=UUID(item)) for item in candidate.rule_collections),
                *(TopicRule(source_code=source) for source in candidate.rule_sources),
            )
        )
        # About four characters per token; the provider's tokenizer decides.
        return TopicClassificationPrompt(
            prompt=prompt, rules=rules, estimated_tokens=math.ceil(len(prompt) / 4)
        )

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
    return (await topic_records(session, authorizer, principal, [topic]))[0]


async def topic_records(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    topics: Sequence[Topic],
    *,
    full: bool = True,
    counts: Mapping[UUID, int] | None = None,
) -> list[TopicRecord]:
    """Records of ``topics`` (one workspace); parents, evidence and counts load once for all.

    ``full`` False (ListTopics view BASIC) leaves out the signals, evidence and
    ``inReviewCount`` and their queries; ``counts`` are document counts the
    caller already selected (ListTopics sorts on them), else they load here.
    """
    if not topics:
        return []
    workspace_id = topics[0].tenant_id
    ids = [topic.id for topic in topics]
    parents: dict[UUID, str] = {topic.id: topic.code for topic in topics}
    missing = {
        topic.parent_topic_id
        for topic in topics
        if topic.parent_topic_id is not None and topic.parent_topic_id not in parents
    }
    if missing:
        parents.update(
            (await session.execute(select(Topic.id, Topic.code).where(Topic.id.in_(missing))))
            .tuples()
            .all()
        )
    if counts is None:
        counts = await document_counts(session, authorizer, principal, workspace_id, ids)
    evidence: dict[UUID, list[UUID]] = {}
    in_review: dict[UUID, int] | None = None
    visible_examples: set[UUID] = set()
    if full:
        rows = await session.execute(
            select(ContributionTopic.topic_id, Contribution.id)
            .join(ContributionTopic, ContributionTopic.contribution_id == Contribution.id)
            .where(
                ContributionTopic.topic_id.in_(ids),
                ContributionTopic.relation == "proposed",
                Contribution.deleted_at.is_(None),
                await readable_clause(authorizer, principal, workspace_id),
            )
            .order_by(Contribution.created_at, Contribution.id)
        )
        for topic_id, contribution_id in rows:
            evidence.setdefault(topic_id, []).append(contribution_id)
        if await is_any_reviewer(authorizer, principal, workspace_id):
            reviewed = await session.execute(
                select(ContributionTopic.topic_id, func.count(distinct(Contribution.id)))
                .join(ContributionTopic, ContributionTopic.contribution_id == Contribution.id)
                .where(
                    ContributionTopic.topic_id.in_(ids),
                    Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
                    Contribution.deleted_at.is_(None),
                    await reviewer_clause(authorizer, principal, workspace_id),
                )
                .group_by(ContributionTopic.topic_id)
            )
            in_review = {topic_id: int(count) for topic_id, count in reviewed}
        example_ids = {example for topic in topics for example in topic.example_item_ids}
        if example_ids:
            visible_examples = set(
                await session.scalars(
                    select(Item.id).where(
                        Item.id.in_(example_ids),
                        await _visible_documents(authorizer, principal, workspace_id),
                    )
                )
            )
    return [
        TopicRecord(
            workspace_id=workspace_id,
            id=topic.id,
            code=topic.code,
            display_name=topic.topic_name,
            description=topic.description,
            kind=topic.kind,
            parent_code=parents.get(topic.parent_topic_id) if topic.parent_topic_id else None,
            icon=topic.icon,
            color=topic.color,
            signals=_topic_signals(topic, visible=visible_examples) if full else None,
            state=_state(topic),
            evidence=tuple(evidence.get(topic.id, ())) if full else None,
            document_count=counts.get(topic.id, 0),
            in_review_count=in_review.get(topic.id, 0) if in_review is not None else None,
            create_time=topic.created_at,
            update_time=topic.updated_at,
            delete_time=topic.deleted_at,
            purge_time=purge_time(topic.deleted_at),
            etag=topic_etag(topic),
        )
        for topic in topics
    ]


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
        _tagged_counts(visible).where(ItemTopic.topic_id.in_(topic_ids))
    )
    return {topic_id: int(count) for topic_id, count in rows}


def _tagged_counts(visible: ColumnElement[bool]) -> Select[tuple[UUID, int]]:
    """``(topic_id, document_count)`` of the visible documents tagged with each topic."""
    return (
        select(ItemTopic.topic_id, func.count().label("document_count"))
        .join(Item, Item.id == ItemTopic.item_id)
        .where(visible)
        .group_by(ItemTopic.topic_id)
    )


async def _visible_documents(
    authorizer: Authorizer, principal: Principal, workspace_id: UUID
) -> ColumnElement[bool]:
    visibility = await item_visibility(authorizer, principal, workspace_id)
    return visibility.clause()


def _state(topic: Topic) -> str:
    return "deleted" if topic.deleted_at is not None else topic.state


# -- Classification signals ------------------------------------------------------------


def _topic_signals(topic: Topic, *, visible: Collection[UUID] | None = None) -> TopicSignals:
    """``topic``'s stored signals; ``visible`` narrows the examples to what a caller sees."""
    return TopicSignals(
        keywords=tuple(topic.keywords),
        synonyms=tuple(topic.synonyms),
        guidance=topic.guidance,
        example_ids=tuple(
            example
            for example in topic.example_item_ids
            if visible is None or example in visible
        ),
        rules=(
            *(TopicRule(collection_id=collection) for collection in topic.rule_collection_ids),
            *(TopicRule(source_code=source) for source in topic.rule_source_codes),
        ),
    )


def _signal_values(signals: TopicSignals) -> dict[str, Any]:
    """``signals`` keyed by mask path, as UpdateTopic changes."""
    return {
        "keywords": signals.keywords,
        "synonyms": signals.synonyms,
        "guidance": signals.guidance,
        "examples": signals.example_ids,
        "rules": signals.rules,
    }


def _set_signals(topic: Topic, signals: TopicSignals) -> None:
    topic.keywords = list(signals.keywords)
    topic.synonyms = list(signals.synonyms)
    topic.guidance = signals.guidance
    topic.example_item_ids = list(signals.example_ids)
    topic.rule_collection_ids = [
        rule.collection_id for rule in signals.rules if rule.collection_id is not None
    ]
    topic.rule_source_codes = [
        rule.source_code for rule in signals.rules if rule.source_code is not None
    ]


def _terms(values: Sequence[str] | None, field: str) -> tuple[str, ...]:
    """Trimmed, non-empty terms without case-insensitive repeats, within the limits."""
    terms: dict[str, str] = {}
    for value in values or ():
        term = value.strip()
        if term:
            terms.setdefault(term.casefold(), term)
    if len(terms) > MAX_TERMS:
        raise InvalidArgument.for_field(field, f"At most {MAX_TERMS} {field} are allowed.")
    if any(len(term) > MAX_TERM_LENGTH for term in terms.values()):
        raise InvalidArgument.for_field(
            field, f"Each of {field} is at most {MAX_TERM_LENGTH} characters."
        )
    return tuple(terms.values())


def _guidance(value: str | None) -> str | None:
    guidance = value.strip() if value else ""
    if len(guidance) > MAX_GUIDANCE:
        raise InvalidArgument.for_field("guidance", f"guidance is at most {MAX_GUIDANCE} characters.")
    return guidance or None


def _icon(value: str | None) -> str | None:
    """An icon name; empty clears it."""
    if not value:
        return None
    if not _ICON.fullmatch(value):
        raise InvalidArgument.for_field(
            "icon",
            "icon is an icon name: a lowercase letter, then up to 63 lowercase letters, digits or hyphens.",
        )
    return value


def _color(value: str | None) -> str | None:
    """A ``#RRGGBB`` colour, stored lowercase; empty clears it."""
    if not value:
        return None
    color = value.lower()
    if not _COLOR.fullmatch(color):
        raise InvalidArgument.for_field("color", "color is a #RRGGBB hex colour.")
    return color


async def _validated_signals(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    kind: str,
    values: Mapping[str, Any],
    *,
    current: TopicSignals = TopicSignals(),
) -> TopicSignals:
    """``current`` with the signal paths in ``values`` validated and applied.

    Examples must be documents and rule collections collections the caller can
    see (else PERMISSION_DENIED, as for any referenced item); rule sources must
    be live sources of the workspace. A DOMAIN has no signals.
    """
    examples = (
        tuple(dict.fromkeys(values["examples"] or ())) if "examples" in values else current.example_ids
    )
    rules = tuple(dict.fromkeys(values["rules"] or ())) if "rules" in values else current.rules
    if len(examples) > MAX_EXAMPLES:
        raise InvalidArgument.for_field("examples", f"At most {MAX_EXAMPLES} examples are allowed.")
    if len(rules) > MAX_RULES:
        raise InvalidArgument.for_field("rules", f"At most {MAX_RULES} rules are allowed.")
    signals = TopicSignals(
        keywords=_terms(values["keywords"], "keywords") if "keywords" in values else current.keywords,
        synonyms=_terms(values["synonyms"], "synonyms") if "synonyms" in values else current.synonyms,
        guidance=_guidance(values["guidance"]) if "guidance" in values else current.guidance,
        example_ids=examples,
        rules=rules,
    )
    if kind == "domain" and signals != TopicSignals():
        raise InvalidArgument.for_field(
            next(iter(values), "keywords"),
            "A DOMAIN has no keywords, synonyms, guidance, examples or rules.",
        )
    new_examples = examples if "examples" in values else ()
    new_collections = tuple(
        rule.collection_id for rule in rules if "rules" in values and rule.collection_id is not None
    )
    if new_examples or new_collections:
        kinds = dict(
            (
                await session.execute(
                    select(Item.id, Item.item_kind).where(
                        Item.id.in_([*new_examples, *new_collections]),
                        await _visible_documents(ctx.authorizer, ctx.principal, workspace_id),
                    )
                )
            )
            .tuples()
            .all()
        )
        for item_id in (*new_examples, *new_collections):
            if item_id not in kinds:
                raise permission_denied("items.get", ItemRef(workspace_id, item_id))
        if any(kinds[item_id] != "document" for item_id in new_examples):
            raise InvalidArgument.for_field("examples", "Every example must be a DOCUMENT item.")
        if any(kinds[item_id] != "collection" for item_id in new_collections):
            raise InvalidArgument.for_field("rules", "A collection rule names a COLLECTION item.")
    sources = {rule.source_code for rule in rules if "rules" in values and rule.source_code}
    if sources:
        live = set(
            await session.scalars(
                select(IngestionSource.code).where(
                    IngestionSource.tenant_id == workspace_id,
                    IngestionSource.code.in_(sources),
                    IngestionSource.deleted_at.is_(None),
                )
            )
        )
        if missing := sorted(sources - live):
            raise InvalidArgument.for_field(
                "rules", f"'{missing[0]}' is not a source of this workspace."
            )
    return signals


# -- Import ------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _NewTopic:
    """A topic or domain an import creates; ``parent_code`` may name another new one."""

    code: str
    kind: str
    parent_code: str | None
    display_name: str
    description: str | None = None
    keywords: tuple[str, ...] = ()
    synonyms: tuple[str, ...] = ()
    guidance: str | None = None
    #: A domain created only because topic rows name it (no row of its own).
    implicit: bool = False


@dataclass(slots=True)
class _ImportPlan:
    """An import's outcome by code. ``new`` and ``changes`` carry their row's position;
    ``matched`` are the existing topics some row resolved to (REPLACE keeps them);
    ``parents`` is the domain code of every live topic once the import applied."""

    parents: dict[str, str | None]
    new: list[tuple[int, _NewTopic]] = field(default_factory=list)
    changes: dict[str, tuple[int, dict[str, Any]]] = field(default_factory=dict)
    matched: set[str] = field(default_factory=set)
    unchanged: int = 0
    skipped: list[tuple[int, str]] = field(default_factory=list)


class _Skip(Exception):
    """A row that cannot apply; the message is its reason."""


def _match_key(display_name: str) -> str:
    """How an import compares display names: case and whitespace do not count."""
    return " ".join(display_name.split()).casefold()


def _generated_code() -> str:
    """A server-generated topic ID."""
    return f"t{uuid4().hex[:12]}"


def _import_row(
    row: TopicImportRow, workspace_id: UUID, existing: Mapping[str, Topic]
) -> tuple[TopicImportRow, Topic | None]:
    """The trimmed row and the live ACTIVE topic its ``name`` identifies; :class:`_Skip` otherwise."""
    domain = row.domain.strip()
    topic = (row.topic or "").strip() or None
    kind = "topic" if topic else "domain"
    if not domain:
        raise _Skip("The domain is required.")
    if len(domain) > MAX_DISPLAY_NAME or len(topic or "") > MAX_DISPLAY_NAME:
        raise _Skip(f"A domain or topic name is at most {MAX_DISPLAY_NAME} characters.")
    try:
        keywords = _terms(row.keywords, "keywords") if row.keywords is not None else None
        synonyms = _terms(row.synonyms, "synonyms") if row.synonyms is not None else None
        guidance = _guidance(row.guidance) if row.guidance is not None else None
    except InvalidArgument as exc:
        raise _Skip(exc.message) from None
    if kind == "domain" and (keywords or synonyms or guidance):
        raise _Skip("A domain has no keywords, synonyms or guidance.")
    target = None
    if ref := (row.name or "").strip():
        try:
            target = existing.get(parse_topic(ref, workspace_id, field="name"))
        except InvalidArgument:
            target = None
        if target is None:
            raise _Skip(f"'{ref}' is not a topic of this workspace.")
        if target.deleted_at is not None:
            raise _Skip(f"'{ref}' is archived; restore it first.")
        if target.state != "active":
            raise _Skip(f"'{ref}' is not ACTIVE.")
        if target.kind != kind:
            raise _Skip(f"'{ref}' is a {target.kind}, not a {kind}.")
    normalized = TopicImportRow(
        domain=domain,
        topic=topic,
        description=row.description.strip() if row.description is not None else None,
        keywords=keywords,
        synonyms=synonyms,
        guidance=guidance,
    )
    return normalized, target


def _plan_import(
    workspace_id: UUID, rows: Sequence[TopicImportRow], existing: Mapping[str, Topic]
) -> _ImportPlan:
    """Resolve every row to a domain or topic, existing or new, by display name.

    Rows with a ``name`` claim their topic first, domain rows before topic rows, so a
    rename or move wins over a row matching the old name.
    """
    planner = _ImportPlanner(workspace_id, existing)
    prepared: list[tuple[int, TopicImportRow, Topic | None]] = []
    for position, row in enumerate(rows, start=1):
        try:
            prepared.append((position, *_import_row(row, workspace_id, existing)))
        except _Skip as exc:
            planner.plan.skipped.append((position, str(exc)))
    prepared.sort(key=lambda entry: (entry[1].topic is not None, entry[2] is None))
    for position, row, target in prepared:
        try:
            if row.topic is None:
                planner.domain_row(position, row, target)
            else:
                planner.topic_row(position, row, row.topic, target)
        except _Skip as exc:
            planner.plan.skipped.append((position, str(exc)))
    planner.plan.skipped.sort()
    return planner.plan


class _ImportPlanner:
    """Matches import rows by display name. A name matches an ACTIVE domain (a topic:
    an ACTIVE topic of its domain) no other row claimed; none matching = it is
    created, also a domain that only topic rows name. A name a row already used in
    its domain skips the row."""

    def __init__(self, workspace_id: UUID, existing: Mapping[str, Topic]) -> None:
        self._workspace_id = workspace_id
        self._existing = existing
        codes = {topic.id: topic.code for topic in existing.values()}
        self.plan = _ImportPlan(
            parents={
                code: codes.get(topic.parent_topic_id) if topic.parent_topic_id else None
                for code, topic in existing.items()
                if topic.deleted_at is None
            }
        )
        #: Live ACTIVE domains by match key; topics by (domain code, match key).
        self._domains: dict[str, list[str]] = defaultdict(list)
        self._topics: dict[tuple[str, str], list[str]] = defaultdict(list)
        for topic in existing.values():
            if topic.state != "active" or topic.deleted_at is not None:
                continue
            if topic.kind == "domain":
                self._domains[_match_key(topic.topic_name)].append(topic.code)
            elif (parent := self.plan.parents[topic.code]) is not None:
                self._topics[(parent, _match_key(topic.topic_name))].append(topic.code)
        #: What the rows applied so far named: domain match key → code, (domain, topic key).
        self._file_domains: dict[str, str] = {}
        self._file_topics: set[tuple[str, str]] = set()
        self._taken = set(existing)

    def domain_row(self, position: int, row: TopicImportRow, target: Topic | None) -> None:
        self._unclaimed_target(target)
        key = _match_key(row.domain)
        if key in self._file_domains:
            raise _Skip(f"The domain '{row.domain}' is in another row.")
        if target is None and (found := self._unclaimed(self._domains[key], row.domain, "domain")):
            target = self._existing[found]
        if target is None:
            self._file_domains[key] = self._create(
                position, _NewTopic(self._code(), "domain", None, row.domain, row.description or None)
            )
        else:
            self._file_domains[key] = target.code
            self._update(position, target, row, None)

    def topic_row(
        self, position: int, row: TopicImportRow, display_name: str, target: Topic | None
    ) -> None:
        self._unclaimed_target(target)
        domain_key = _match_key(row.domain)
        domain = self._file_domains.get(domain_key) or self._unclaimed(
            self._domains[domain_key], row.domain, "domain"
        )
        topic_key = _match_key(display_name)
        if domain is not None:
            if (domain, topic_key) in self._file_topics:
                raise _Skip(f"The topic '{display_name}' of '{row.domain}' is in another row.")
            if target is None and (
                found := self._unclaimed(self._topics[(domain, topic_key)], display_name, "topic")
            ):
                target = self._existing[found]
            self.plan.matched.add(domain)
        else:
            domain = self._create(
                position, _NewTopic(self._code(), "domain", None, row.domain, implicit=True)
            )
        self._file_domains[domain_key] = domain
        self._file_topics.add((domain, topic_key))
        if target is not None:
            self._update(position, target, row, domain)
            return
        self._create(
            position,
            _NewTopic(
                self._code(),
                "topic",
                domain,
                display_name,
                row.description or None,
                row.keywords or (),
                row.synonyms or (),
                row.guidance,
            ),
        )

    def _unclaimed_target(self, target: Topic | None) -> None:
        if target is not None and target.code in self.plan.matched:
            raise _Skip(f"'{topic_name(self._workspace_id, target.code)}' is in another row.")

    def _unclaimed(self, candidates: Sequence[str], display_name: str, kind: str) -> str | None:
        free = [code for code in candidates if code not in self.plan.matched]
        if len(free) > 1:
            raise _Skip(f"'{display_name}' matches more than one {kind}.")
        return free[0] if free else None

    def _code(self) -> str:
        while (code := _generated_code()) in self._taken:
            pass
        self._taken.add(code)
        return code

    def _create(self, position: int, new: _NewTopic) -> str:
        self.plan.new.append((position, new))
        if new.kind == "topic":
            self.plan.parents[new.code] = new.parent_code
        return new.code

    def _update(
        self, position: int, topic: Topic, row: TopicImportRow, parent: str | None
    ) -> None:
        self.plan.matched.add(topic.code)
        if changed := _import_changes(topic, row, parent, self.plan.parents.get(topic.code)):
            self.plan.changes[topic.code] = (position, changed)
            if "parent_code" in changed:
                self.plan.parents[topic.code] = parent
        else:
            self.plan.unchanged += 1


def _import_changes(
    topic: Topic, row: TopicImportRow, parent_code: str | None, current_parent: str | None
) -> dict[str, Any]:
    """The row's present columns that differ from ``topic``, by attribute; a topic's
    domain compares by code under the key ``parent_code``."""
    wanted: dict[str, Any] = {"topic_name": row.topic if topic.kind == "topic" else row.domain}
    if row.description is not None:
        wanted["description"] = row.description or None
    if row.keywords is not None:
        wanted["keywords"] = list(row.keywords)
    if row.synonyms is not None:
        wanted["synonyms"] = list(row.synonyms)
    if row.guidance is not None:
        wanted["guidance"] = row.guidance
    changed = {key: value for key, value in wanted.items() if getattr(topic, key) != value}
    if topic.kind == "topic" and parent_code != current_parent:
        changed["parent_code"] = parent_code
    return changed


#: TopicImportChange ``changes`` by ``_import_changes`` key, in the contract's order.
_CHANGE_KINDS = {
    "topic_name": "RENAMED",
    "parent_code": "MOVED",
    "description": "DESCRIPTION",
    "keywords": "KEYWORDS",
    "synonyms": "SYNONYMS",
    "guidance": "GUIDANCE",
}


def _import_result(
    existing: Mapping[str, Topic], plan: _ImportPlan, archived: Sequence[Topic], unchanged: int
) -> TopicImportResult:
    """The outcome named the way the file names it: display names after the import."""
    names = {code: topic.topic_name for code, topic in existing.items()}
    for code, (_, changed) in plan.changes.items():
        names[code] = changed.get("topic_name", names[code])
    for _, new in plan.new:
        names[new.code] = new.display_name
    codes = {topic.id: topic.code for topic in existing.values()}

    def domain_name(parent_code: str | None) -> str | None:
        return names[parent_code] if parent_code is not None else None

    created = tuple(
        TopicImportChange(
            code=new.code,
            kind=new.kind,
            display_name=new.display_name,
            domain=domain_name(new.parent_code),
            row=None if new.implicit else position,
        )
        for position, new in sorted(plan.new, key=lambda entry: entry[0])
    )
    updated = tuple(
        TopicImportChange(
            code=code,
            kind=existing[code].kind,
            display_name=names[code],
            domain=domain_name(plan.parents.get(code)),
            row=position,
            changes=tuple(kind for key, kind in _CHANGE_KINDS.items() if key in changed),
            previous_display_name=existing[code].topic_name if "topic_name" in changed else None,
        )
        for code, (position, changed) in sorted(plan.changes.items(), key=lambda entry: entry[1][0])
    )
    removed = tuple(
        TopicImportChange(
            code=topic.code,
            kind=topic.kind,
            display_name=topic.topic_name,
            domain=domain_name(codes.get(topic.parent_topic_id) if topic.parent_topic_id else None),
        )
        for topic in archived
    )
    return TopicImportResult(
        created=created,
        updated=updated,
        archived=removed,
        unchanged_count=unchanged,
        skipped=tuple(plan.skipped),
    )


async def _apply_import(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    existing: Mapping[str, Topic],
    plan: _ImportPlan,
    archived: Sequence[Topic],
) -> None:
    """Write an import's outcome: new domains, then new topics (one multi-row
    INSERT each, their domains resolved by code), then the updates and archives."""
    ids = {code: topic.id for code, topic in existing.items()}
    for kind in ("domain", "topic"):
        values = [
            {
                "tenant_id": workspace_id,
                "code": new.code,
                "kind": kind,
                "parent_topic_id": ids[new.parent_code] if new.parent_code else None,
                "topic_name": new.display_name,
                "description": new.description,
                "keywords": list(new.keywords),
                "synonyms": list(new.synonyms),
                "guidance": new.guidance,
                "state": "active",
                "created_by_user_id": ctx.user_id,
            }
            for _, new in plan.new
            if new.kind == kind
        ]
        if values:
            inserted = await session.execute(insert(Topic).returning(Topic.code, Topic.id), values)
            ids.update(inserted.tuples().all())
    for code, (_, changed) in plan.changes.items():
        topic = existing[code]
        for key, value in changed.items():
            if key == "parent_code":
                topic.parent_topic_id = ids[value]
            else:
                setattr(topic, key, value)
    if archived:
        removed_at = await now(session)
        for topic in archived:
            topic.deleted_at = removed_at
    await session.flush()


async def _tagged(session: AsyncSession, topic_ids: Sequence[UUID]) -> frozenset[UUID]:
    """The topics of ``topic_ids`` tagging a document or a contribution (see :func:`_in_use`)."""
    if not topic_ids:
        return frozenset()
    return frozenset(
        await session.scalars(
            select(ItemTopic.topic_id)
            .where(ItemTopic.topic_id.in_(topic_ids))
            .union(
                select(ContributionTopic.topic_id).where(ContributionTopic.topic_id.in_(topic_ids))
            )
        )
    )



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


async def classification_candidates(
    session: AsyncSession,
    workspace_id: UUID,
    codes: Sequence[str] = (),
    *,
    overrides: Mapping[str, tuple[str, str | None, TopicSignals]] | None = None,
) -> tuple[TopicCandidate, ...]:
    """CLASSIFYING's candidates, with their signals and example titles, in two queries.

    ``codes`` are a run's topics, a DOMAIN standing for its ACTIVE topics (or
    itself when it has none); none = every ACTIVE topic. A domain whose topics
    are candidates is not one itself: documents are filed under topics.
    ``overrides`` replace a topic's ``(displayName, description, signals)``
    (TestTopicClassification).
    """
    domain = aliased(Topic)
    query = (
        select(Topic, domain.topic_name)
        .outerjoin(domain, domain.id == Topic.parent_topic_id)
        .where(
            Topic.tenant_id == workspace_id,
            Topic.state == "active",
            Topic.deleted_at.is_(None),
        )
        .order_by(Topic.code)
    )
    if codes:
        query = query.where(
            or_(
                Topic.code.in_(codes),
                and_(
                    domain.code.in_(codes),
                    domain.state == "active",
                    domain.deleted_at.is_(None),
                ),
            )
        )
    found = list((await session.execute(query)).tuples())
    parents = {topic.parent_topic_id for topic, _ in found if topic.parent_topic_id}
    rows = [
        (topic, domain_name, *(overrides or {}).get(
            topic.code, (topic.topic_name, topic.description, _topic_signals(topic))
        ))
        for topic, domain_name in found
        if topic.id not in parents
    ]
    example_ids = {example for *_, signals in rows for example in signals.example_ids}
    titles: dict[UUID, str] = {}
    if example_ids:
        titles = dict(
            (
                await session.execute(
                    select(Item.id, Item.item_name).where(
                        Item.id.in_(example_ids), Item.deleted_at.is_(None)
                    )
                )
            )
            .tuples()
            .all()
        )
    return tuple(
        TopicCandidate(
            id=str(topic.id),
            code=topic.code,
            name=name,
            description=description,
            domain=domain_name,
            keywords=signals.keywords,
            synonyms=signals.synonyms,
            guidance=signals.guidance,
            examples=tuple(titles[e] for e in signals.example_ids if titles.get(e)),
            rule_collections=tuple(
                str(rule.collection_id) for rule in signals.rules if rule.collection_id
            ),
            rule_sources=tuple(rule.source_code for rule in signals.rules if rule.source_code),
        )
        for topic, domain_name, name, description, signals in rows
    )


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
        "keywords": list(draft.signals.keywords),
        "synonyms": list(draft.signals.synonyms),
        "guidance": draft.signals.guidance,
        "examples": [str(example) for example in draft.signals.example_ids],
        "rules": [
            [str(rule.collection_id) if rule.collection_id else None, rule.source_code]
            for rule in draft.signals.rules
        ],
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


#: Topics shown under each domain by :func:`topic_summaries`.
TOP_TOPICS = 3


async def topic_summaries(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    limit: int,
    new_since: datetime,
) -> list[TopicDomainSummary]:
    """ACTIVE domains holding documents the caller can see, with their (at most
    :data:`TOP_TOPICS`) largest non-empty ACTIVE topics.

    A domain's count is the distinct visible documents tagged with it or any of
    its topics; its new count, those of them published whose current revision
    was created at or after ``new_since``. Two statements: the topics, then
    every topic and domain count in one ``GROUPING SETS`` query.
    """
    live = (Topic.tenant_id == workspace_id) & (Topic.state == "active") & Topic.deleted_at.is_(None)
    live_domains = select(Topic.id).where(live, Topic.kind == "domain")
    topics = list(
        await session.scalars(
            select(Topic).where(
                live, or_(Topic.kind == "domain", Topic.parent_topic_id.in_(live_domains))
            )
        )
    )
    domains = [topic for topic in topics if topic.kind == "domain"]
    if not domains:
        return []
    domain_ids = [domain.id for domain in domains]
    children = [topic for topic in topics if topic.parent_topic_id in frozenset(domain_ids)]
    domain_of = func.coalesce(Topic.parent_topic_id, Topic.id)
    rows = await session.execute(
        select(
            ItemTopic.topic_id,
            domain_of,
            func.count(distinct(ItemTopic.item_id)),
            func.count(distinct(ItemTopic.item_id)).filter(
                Item.is_published, ItemRevision.created_at >= new_since
            ),
        )
        .select_from(ItemTopic)
        .join(Topic, Topic.id == ItemTopic.topic_id)
        .join(Item, Item.id == ItemTopic.item_id)
        .outerjoin(ItemRevision, ItemRevision.id == Item.current_revision_id)
        .where(
            live,
            Topic.id.in_(domain_ids) | Topic.parent_topic_id.in_(domain_ids),
            await _visible_documents(authorizer, principal, workspace_id),
        )
        .group_by(func.grouping_sets(tuple_(ItemTopic.topic_id), tuple_(domain_of)))
    )
    counts: dict[UUID, int] = {}
    totals: dict[UUID, tuple[int, int]] = {}
    for topic_id, domain_id, count, new_count in rows.tuples():
        if domain_id is None:
            counts[topic_id] = int(count)
        else:
            totals[domain_id] = (int(count), int(new_count))
    summaries = []
    for domain in domains:
        total, new = totals.get(domain.id, (0, 0))
        if not total:
            continue
        top = sorted(
            (
                TopicSummary(t.id, t.code, t.topic_name, counts[t.id])
                for t in children
                if t.parent_topic_id == domain.id and counts.get(t.id)
            ),
            key=lambda s: (-s.document_count, s.display_name),
        )[:TOP_TOPICS]
        summaries.append(
            TopicDomainSummary(
                topic_id=domain.id,
                code=domain.code,
                display_name=domain.topic_name,
                description=domain.description,
                icon=domain.icon,
                color=domain.color,
                document_count=total,
                new_document_count=new,
                top_topics=top,
            )
        )
    summaries.sort(key=lambda s: (-s.document_count, s.display_name))
    return summaries[:limit]


def topic_count_statement(workspace_id: UUID) -> Select[tuple[int]]:
    """``SELECT count(*)`` of the ACTIVE topics (kind TOPIC) of the workspace."""
    return select(func.count()).where(
        Topic.tenant_id == workspace_id,
        Topic.kind == "topic",
        Topic.state == "active",
        Topic.deleted_at.is_(None),
    )


__all__ = [
    "TopicService",
    "classification_candidates",
    "document_counts",
    "resolve_active_topics",
    "topic_count_statement",
    "topic_etag",
    "topic_summaries",
]
