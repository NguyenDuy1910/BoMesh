"""``GetMemberHome``: the member's output-only Home read model.

Composed from other slices' public reads and bounded queries over items the
member can see (``catalog_visibility``): every section holds at most
:data:`SECTION_LIMIT` entries, only readable items appear (except LOCKED root
collections) and duplicates collapse.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import chain, zip_longest
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Row,
    Select,
    and_,
    case,
    distinct,
    func,
    literal,
    select,
    true,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Conversation,
    Item,
    ItemTopic,
    Message,
    RecentItem,
    SavedItem,
    Space,
    SpaceMaterial,
    TenantMembership,
    Topic,
)
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.collaboration.membership import member_space_ids
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.workspaces import module_enabled
from bomesh.services.knowledge_curation.contributions import (
    member_contributions,
    review_queue_count,
)
from bomesh.services.knowledge_curation.records import TopicDomainSummary, TopicSummary
from bomesh.services.knowledge_curation.topics import topic_count, topic_summaries
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.knowledge_items.items import KnowledgeItemService
from bomesh.services.knowledge_items.queries import PUBLISH_TIME, VERIFICATION_STATE
from bomesh.services.library.access import LibraryGate, Owner
from bomesh.services.library.items import readable_reference_lists
from bomesh.services.library.notifications import unread_count
from bomesh.services.library.records import (
    HomeCollection,
    HomeContribution,
    HomeCounts,
    HomeFeatured,
    HomeItem,
    HomeRecommended,
    HomeStarterPrompt,
    HomeTopic,
    HomeTopicDomain,
    ItemReference,
    MemberHomeRecord,
)
from bomesh.services.library.starters import Candidate, best_answers
from bomesh.services.previews.covers import resolve_cover
from bomesh.services.workspaces.members import holds_role
from bomesh.services.workspaces.settings import assistant_settings
from bomesh.storage import DocumentStorage

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SECTION_LIMIT = 8
#: Starter prompts shown on Home.
STARTER_LIMIT = 4
#: Views counted for POPULAR entries.
POPULAR_WINDOW = timedelta(days=30)
#: A domain's documents whose content changed this recently count as new.
NEW_WINDOW = timedelta(days=30)

@dataclass(frozen=True, slots=True)
class Covers:
    """Where Home's signed cover images come from."""

    storage: DocumentStorage
    expires_seconds: int


class MemberHomeService:
    def __init__(
        self,
        sessions: SessionFactory,
        items: KnowledgeItemService,
        covers: Covers,
    ) -> None:
        self._sessions = sessions
        self._items = items
        self._covers = covers
        self._gate = LibraryGate()

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> MemberHomeService:
        return cls(
            runtime.sessions(),
            KnowledgeItemService.from_runtime(runtime),
            Covers(runtime.object_storage(), runtime.config.preview.cover_url_seconds),
        )

    async def get(self, ctx: RequestContext, workspace_id: UUID, member: str) -> MemberHomeRecord:
        owner = await self._gate.open(ctx, workspace_id, member, "members.getHome", write=False)
        async with transaction_scope(self._sessions) as session:
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
        collections = await self._root_collections(ctx, workspace_id, visibility)
        async with transaction_scope(self._sessions) as session:
            composer = _Composer(session, ctx, owner, visibility, self._covers)
            return await composer.compose(collections)

    async def _root_collections(
        self, ctx: RequestContext, workspace_id: UUID, visibility: ItemVisibility
    ) -> tuple[HomeCollection, ...]:
        """Root collections as ListItems shows them (LOCKED discoverable ones last), no PERSONAL."""
        records = await self._items.page(
            ctx,
            workspace_id,
            ListQuery(
                where=and_(
                    Item.item_kind == "collection",
                    Item.parent_item_id.is_(None),
                    Item.item_type != PERSONAL_COLLECTION_TYPE,
                ),
                order_by=(Item.item_name.asc(), Item.id.asc()),
                offset=0,
                limit=SECTION_LIMIT,
            ),
            visibility,
            show_locked=True,
        )
        return tuple(
            HomeCollection(
                workspace_id=workspace_id,
                item_id=record.item_id,
                display_name=record.display_name,
                description=record.collection.description if record.collection else None,
                access=record.access,
                owner_summary=record.collection.owner_summary if record.collection else None,
                document_count=(
                    record.collection.document_count
                    if record.collection and record.access != "LOCKED"
                    else None
                ),
            )
            for record in records
        )


class _Composer:
    """One Home composition inside one read transaction.

    Saved and recent entries pass the reference rule in one lookup and
    their card rows load in one query; the ranked sections (popular, recently
    published, recommended) select their card rows directly.
    """

    def __init__(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        owner: Owner,
        visibility: ItemVisibility,
        covers: Covers,
    ) -> None:
        self._covers = covers
        self._session = session
        self._ctx = ctx
        self._owner = owner
        self._workspace_id = owner.workspace_id
        self._visibility = visibility
        #: Card rows ``(Item, verification state, publish time, …)`` of visible documents.
        self._rows: dict[UUID, Row[Any]] = {}

    async def compose(self, collections: tuple[HomeCollection, ...]) -> MemberHomeRecord:
        saved_rows, recent_rows = await self._entries()
        saved, recent = await readable_reference_lists(
            self._session, self._ctx, self._owner, [saved_rows, recent_rows]
        )
        referenced = {ref.item_id for ref in (*saved, *recent)}
        if referenced:
            await self._load(
                self._card_rows().where(
                    Item.id.in_(referenced),
                    Item.item_kind == "document",
                    self._visibility.clause(),
                )
            )
        # Reference targets' ancestries were memoized by the reference check.
        recent_cards = await self._cards(recent)
        viewed = {card.item_id for card in recent_cards}
        popular = await self._load(self._popular())
        recently_published = await self._load(
            self._card_rows()
            .where(self._published_documents())
            .order_by(PUBLISH_TIME.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        starters = await self._starter_prompts()
        picks = await self._picks(
            starters, viewed, {item_id for item_id, _ in (*saved_rows, *recent_rows)}
        )
        await self._ctx.authorizer.ancestries(self._rows)
        popular_cards = await self._cards_of(popular)
        topics = await topic_summaries(
            self._session,
            self._ctx.authorizer,
            self._ctx.principal,
            self._workspace_id,
            limit=SECTION_LIMIT,
            new_since=datetime.now(UTC) - NEW_WINDOW,
        )
        collection_count, document_count = await self._counts()
        join_time, conversation_count = await self._membership()
        return MemberHomeRecord(
            owner_workspace_id=self._workspace_id,
            owner_user_id=self._owner.user_id,
            join_time=join_time,
            counts=HomeCounts(
                collection_count=collection_count,
                document_count=document_count,
                saved_item_count=len(saved),
                topic_count=await topic_count(self._session, self._workspace_id),
                conversation_count=conversation_count,
                unread_notification_count=await unread_count(
                    self._session, self._ctx, self._owner, self._visibility
                ),
            ),
            starter_prompts=starters,
            topic_domains=tuple(
                HomeTopicDomain(
                    domain=self._topic(domain),
                    description=domain.description,
                    icon=domain.icon,
                    color=domain.color,
                    new_document_count=domain.new_document_count,
                    top_topics=tuple(self._topic(topic) for topic in domain.top_topics),
                )
                for domain in topics
            ),
            collections=collections,
            featured=self._featured(popular_cards),
            recently_published=tuple(await self._cards_of(recently_published)),
            recommended=await self._recommended(picks),
            recent_items=tuple(recent_cards[:SECTION_LIMIT]),
            contributions=tuple(
                HomeContribution(
                    workspace_id=self._workspace_id,
                    contribution_id=entry.contribution_id,
                    display_name=entry.display_name,
                    state=entry.state,
                )
                for entry in await member_contributions(
                    self._session, self._workspace_id, self._owner.user_id, limit=SECTION_LIMIT
                )
            ),
            review_queue_count=await review_queue_count(
                self._session, self._ctx.authorizer, self._ctx.principal, self._workspace_id
            ),
            up_next=tuple(
                card
                for card in await self._cards(saved)
                if card.item_id not in viewed
            )[:SECTION_LIMIT],
        )

    # -- Sections -------------------------------------------------------------

    async def _starter_prompts(self) -> tuple[HomeStarterPrompt, ...]:
        """The assistant's starter prompts for one of the caller's roles, else those for every role."""
        prompts = (await assistant_settings(self._session, self._workspace_id)).starter_prompts
        held = await self._held_roles(dict.fromkeys(role for p in prompts for role in p.roles))
        chosen = [p for p in prompts if held.intersection(p.roles)] or [
            p for p in prompts if not p.roles
        ]
        unique = dict.fromkeys(HomeStarterPrompt(p.title, p.prompt) for p in chosen)
        return tuple(unique)[:STARTER_LIMIT]

    @staticmethod
    def _featured(popular: Sequence[HomeItem]) -> tuple[HomeFeatured, ...]:
        """The most viewed readable documents."""
        return tuple(
            HomeFeatured(item=card, position=position)
            for position, card in enumerate(popular[:SECTION_LIMIT])
        )

    async def _picks(
        self,
        starters: Sequence[HomeStarterPrompt],
        viewed: set[UUID],
        seen: set[UUID],
    ) -> list[tuple[UUID, str, str]]:
        """Recommended ``(item ID, reason kind, reason label)``, best first; rows loaded.

        One of each personal reason in turn — the document answering a starter
        prompt (STARTER_PROMPT), a material of one of the member's spaces
        (FROM_YOUR_SPACE), one sharing a topic with what they read lately
        (BECAUSE_YOU_READ) — then the most read (POPULAR) in the domains of the
        answers and reads (the whole workspace when there are none). Nothing the
        member saved or opened; each document once.
        """
        answered = await self._answers(starters, seen)
        in_space = await self._space_materials(seen)
        read_topics = await self._read_topics(viewed)
        related = await self._related(read_topics, seen)
        near = {domain for _, domain, _ in read_topics.values()}
        near.update(await self._domains_of([item_id for item_id, _ in answered]))
        popular = await self._load(
            self._popular(
                _unseen(seen | {item_id for item_id, _ in (*answered, *in_space, *related)}),
                Item.id.in_(self._in_domains(near)) if near else true(),
            )
        )
        lanes = (
            [(item_id, "STARTER_PROMPT", title) for item_id, title in answered],
            [(item_id, "FROM_YOUR_SPACE", space) for item_id, space in in_space],
            [(item_id, "BECAUSE_YOU_READ", topic) for item_id, topic in related],
        )
        ordered = chain(
            (pick for turn in zip_longest(*lanes) for pick in turn if pick is not None),
            ((item_id, "POPULAR", "") for item_id in popular),
        )
        picks: list[tuple[UUID, str, str]] = []
        shown: set[UUID] = set()
        for pick in ordered:
            if pick[0] not in shown and pick[0] in self._rows:
                shown.add(pick[0])
                picks.append(pick)
        return picks[:SECTION_LIMIT]

    async def _recommended(
        self, picks: Sequence[tuple[UUID, str, str]]
    ) -> tuple[HomeRecommended, ...]:
        cards = {card.item_id: card for card in await self._cards_of([p[0] for p in picks])}
        return tuple(
            HomeRecommended(item=cards[item_id], reason_kind=kind, reason_label=label)
            for item_id, kind, label in picks
        )

    async def _answers(
        self, starters: Sequence[HomeStarterPrompt], seen: set[UUID]
    ) -> list[tuple[UUID, str]]:
        """``(item ID, starter title)``: the unseen readable document best answering each starter.

        Scored over the titles and summaries of every unseen readable published
        document (:mod:`bomesh.services.library.starters`).
        """
        if not starters:
            return []
        rows = await self._session.execute(
            select(Item.id, Item.item_name, Item.description)
            .where(self._published_documents(), _unseen(seen))
            .order_by(Item.updated_at.desc(), Item.id)
        )
        candidates = [Candidate(item_id, title, summary) for item_id, title, summary in rows]
        answers = best_answers(candidates, [starter.prompt for starter in starters])
        answered = [
            (item_id, starter.title)
            for item_id, starter in zip(answers, starters, strict=True)
            if item_id is not None
        ]
        if answered:
            await self._load(
                self._card_rows().where(
                    Item.id.in_({item_id for item_id, _ in answered}),
                    self._published_documents(),
                )
            )
        return answered

    async def _space_materials(self, seen: set[UUID]) -> list[tuple[UUID, str]]:
        """``(item ID, space name)``: unseen readable published materials of the member's
        spaces, most recently updated first (none when the spaces module is off)."""
        workspace = await self._ctx.authorizer.workspace(self._workspace_id)
        if workspace is None or not module_enabled(workspace, "spaces"):
            return []
        spaces = await member_space_ids(self._session, self._workspace_id, self._owner.user_id)
        if not spaces:
            return []
        materials = (
            select(SpaceMaterial.item_id, func.min(Space.space_name).label("space_name"))
            .join(Space, Space.id == SpaceMaterial.space_id)
            .where(SpaceMaterial.space_id.in_(spaces))
            .group_by(SpaceMaterial.item_id)
            .subquery()
        )
        rows = await self._load_rows(
            self._card_rows()
            .add_columns(materials.c.space_name)
            .join(materials, materials.c.item_id == Item.id)
            .where(self._published_documents(), _unseen(seen))
            .order_by(Item.updated_at.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        return [(row[0].id, row[3]) for row in rows]

    async def _read_topics(self, viewed: set[UUID]) -> dict[UUID, tuple[str, UUID, int]]:
        """Live topics of the readable documents the member read lately:
        ``topic ID → (name, domain ID, how many of those reads carry it)``."""
        if not viewed:
            return {}
        rows = await self._session.execute(
            select(
                Topic.id,
                Topic.topic_name,
                func.coalesce(Topic.parent_topic_id, Topic.id),
                func.count(ItemTopic.item_id),
            )
            .join(ItemTopic, ItemTopic.topic_id == Topic.id)
            .where(ItemTopic.item_id.in_(viewed), self._live_topic())
            .group_by(Topic.id)
        )
        return {
            topic_id: (name, domain_id, int(count))
            for topic_id, name, domain_id, count in rows.tuples()
        }

    async def _related(
        self, read_topics: dict[UUID, tuple[str, UUID, int]], seen: set[UUID]
    ) -> list[tuple[UUID, str]]:
        """``(item ID, topic name)``: unseen readable published documents sharing the most
        reads' topics, each labelled with its most read topic."""
        if not read_topics:
            return []
        weight = case(
            {topic_id: reads for topic_id, (_, _, reads) in read_topics.items()},
            value=ItemTopic.topic_id,
            else_=0,
        )
        scored = (
            select(
                ItemTopic.item_id,
                func.sum(weight).label("score"),
                func.array_agg(ItemTopic.topic_id).label("topics"),
            )
            .where(ItemTopic.topic_id.in_(read_topics))
            .group_by(ItemTopic.item_id)
            .subquery()
        )
        rows = await self._load_rows(
            self._card_rows()
            .add_columns(scored.c.topics)
            .join(scored, scored.c.item_id == Item.id)
            .where(self._published_documents(), _unseen(seen))
            .order_by(scored.c.score.desc(), Item.updated_at.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        return [
            (
                row[0].id,
                read_topics[
                    min(row[3], key=lambda t: (-read_topics[t][2], read_topics[t][0]))
                ][0],
            )
            for row in rows
        ]

    async def _domains_of(self, item_ids: Sequence[UUID]) -> set[UUID]:
        """The domains of the live topics of ``item_ids``."""
        if not item_ids:
            return set()
        domains = await self._session.scalars(
            select(distinct(func.coalesce(Topic.parent_topic_id, Topic.id)))
            .join(ItemTopic, ItemTopic.topic_id == Topic.id)
            .where(ItemTopic.item_id.in_(item_ids), self._live_topic())
        )
        return set(domains)

    def _in_domains(self, domains: set[UUID]) -> Select[Any]:
        """IDs of the items tagged with a live topic of ``domains`` (or a domain itself)."""
        return (
            select(ItemTopic.item_id)
            .join(Topic, Topic.id == ItemTopic.topic_id)
            .where(func.coalesce(Topic.parent_topic_id, Topic.id).in_(domains), self._live_topic())
        )

    def _popular(self, *conditions: ColumnElement[bool]) -> Select[Any]:
        """Readable published documents most viewed by members over :data:`POPULAR_WINDOW`."""
        since = datetime.now(UTC) - POPULAR_WINDOW
        return (
            self._card_rows()
            .join(RecentItem, RecentItem.item_id == Item.id)
            .where(
                self._published_documents(),
                RecentItem.tenant_id == self._workspace_id,
                RecentItem.viewed_at >= since,
                *conditions,
            )
            .group_by(Item.id)
            .order_by(func.count(RecentItem.user_id).desc(), Item.id)
            .limit(SECTION_LIMIT)
        )

    # -- Building blocks ------------------------------------------------------

    async def _entries(self) -> tuple[list[tuple[UUID, datetime]], list[tuple[UUID, datetime]]]:
        """The member's saved and recent entries ``(item ID, time)``, newest first, in one query."""
        saved = select(
            literal(True).label("saved"),
            SavedItem.item_id.label("item_id"),
            SavedItem.created_at.label("moment"),
        ).where(SavedItem.tenant_id == self._workspace_id, SavedItem.user_id == self._owner.user_id)
        recent = select(
            literal(False), RecentItem.item_id, RecentItem.viewed_at
        ).where(RecentItem.tenant_id == self._workspace_id, RecentItem.user_id == self._owner.user_id)
        entries = union_all(saved, recent).subquery()
        rows = await self._session.execute(
            select(entries).order_by(entries.c.moment.desc(), entries.c.item_id)
        )
        lists: dict[bool, list[tuple[UUID, datetime]]] = {True: [], False: []}
        for is_saved, item_id, moment in rows.tuples():
            lists[is_saved].append((item_id, moment))
        return lists[True], lists[False]

    async def _membership(self) -> tuple[datetime | None, int]:
        """The member's join time and how many of their live conversations hold a message."""
        conversations = (
            select(func.count(Conversation.id))
            .where(
                Conversation.tenant_id == self._workspace_id,
                Conversation.owner_user_id == self._owner.user_id,
                Conversation.deleted_at.is_(None),
                select(Message.id).where(Message.conversation_id == Conversation.id).exists(),
            )
            .scalar_subquery()
        )
        row = (
            await self._session.execute(
                select(TenantMembership.joined_at, conversations).where(
                    TenantMembership.tenant_id == self._workspace_id,
                    TenantMembership.user_id == self._owner.user_id,
                )
            )
        ).one()
        return row[0], int(row[1])

    def _card_rows(self) -> Select[Any]:
        return select(Item, VERIFICATION_STATE, PUBLISH_TIME)

    async def _load_rows(self, statement: Select[Any]) -> list[Row[Any]]:
        """Run a card-row query (visible documents only), keeping its rows; returns them in order."""
        rows = list((await self._session.execute(statement)).all())
        for row in rows:
            self._rows[row[0].id] = row
        return rows

    async def _load(self, statement: Select[Any]) -> list[UUID]:
        """Run a card-row query (visible documents only); returns the item IDs in order."""
        return [row[0].id for row in await self._load_rows(statement)]

    async def _cards(self, references: Iterable[ItemReference]) -> list[HomeItem]:
        """Document cards of the references' items, first occurrence kept."""
        return await self._cards_of([ref.item_id for ref in references])

    async def _cards_of(self, item_ids: Sequence[UUID]) -> list[HomeItem]:
        """Cards of the loaded documents among ``item_ids``, in that order.

        ``governing_collection`` reads the authorizer memo filled when the rows
        loaded; a cover is read from the loaded row and signed, no query.
        """
        cards: list[HomeItem] = []
        for item_id in dict.fromkeys(item_ids):
            row = self._rows.get(item_id)
            if row is None:
                continue
            item, verification_state, publish_time = row[:3]
            cards.append(
                HomeItem(
                    workspace_id=self._workspace_id,
                    item_id=item_id,
                    display_name=item.item_name,
                    collection_id=await self._ctx.authorizer.governing_collection(item_id),
                    verification_state=verification_state,
                    publish_time=publish_time,
                    cover=resolve_cover(
                        self._covers.storage,
                        item,
                        expires_seconds=self._covers.expires_seconds,
                    ),
                )
            )
        return cards

    def _published_documents(self) -> ColumnElement[bool]:
        return and_(
            Item.item_kind == "document",
            Item.is_published,
            self._visibility.clause(),
        )

    def _live_topic(self) -> ColumnElement[bool]:
        return and_(
            Topic.tenant_id == self._workspace_id,
            Topic.state == "active",
            Topic.deleted_at.is_(None),
        )

    async def _counts(self) -> tuple[int, int]:
        """Visible collections and visible published documents, in one statement."""
        collections, documents = (
            await self._session.execute(
                select(
                    func.count().filter(Item.item_kind == "collection"),
                    func.count().filter(
                        and_(Item.item_kind == "document", Item.is_published)
                    ),
                ).where(self._visibility.clause())
            )
        ).one()
        return int(collections), int(documents)

    async def _held_roles(self, roles: Iterable[str]) -> frozenset[str]:
        """Which of ``roles`` the caller holds (directly or through a group), in one statement."""
        scopes = {
            role: scope
            for role in roles
            if (scope := _role_scope(role, self._workspace_id)) is not None
        }
        if not scopes:
            return frozenset()
        names = list(scopes)
        row = (
            await self._session.execute(
                select(*(holds_role(*scopes[name]) for name in names)).where(
                    TenantMembership.tenant_id == self._workspace_id,
                    TenantMembership.user_id == self._owner.user_id,
                    TenantMembership.deleted_at.is_(None),
                )
            )
        ).first()
        if row is None:
            return frozenset()
        return frozenset(name for name, held in zip(names, row, strict=True) if held)

    def _topic(self, summary: TopicSummary | TopicDomainSummary) -> HomeTopic:
        return HomeTopic(
            workspace_id=self._workspace_id,
            code=summary.code,
            display_name=summary.display_name,
            document_count=summary.document_count,
        )


def _unseen(seen: set[UUID]) -> ColumnElement[bool]:
    return Item.id.not_in(seen) if seen else true()


def _role_scope(role: str, workspace_id: UUID) -> tuple[UUID | None, str] | None:
    """``(role_tenant_id, code)`` of ``roles/{r}`` or ``workspaces/{w}/roles/{r}``."""
    parts = role.split("/")
    if len(parts) == 2 and parts[0] == "roles":
        return None, parts[1]
    if len(parts) == 4 and parts[:3] == ["workspaces", str(workspace_id), "roles"]:
        return workspace_id, parts[3]
    return None


__all__ = [
    "NEW_WINDOW",
    "POPULAR_WINDOW",
    "SECTION_LIMIT",
    "STARTER_LIMIT",
    "Covers",
    "MemberHomeService",
]
