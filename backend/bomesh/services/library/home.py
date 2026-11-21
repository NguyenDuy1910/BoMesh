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
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import (
    ColumnElement,
    Row,
    Select,
    and_,
    func,
    literal,
    select,
    true,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, RecentItem, SavedItem, TenantMembership
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
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
    HomeTopic,
    HomeTopicDomain,
    ItemReference,
    MemberHomeRecord,
)
from bomesh.services.previews.covers import resolve_cover
from bomesh.services.workspaces.members import holds_role
from bomesh.services.workspaces.settings import assistant_settings
from bomesh.storage import DocumentStorage

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SECTION_LIMIT = 8
#: Views counted for POPULAR entries.
POPULAR_WINDOW = timedelta(days=30)


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
        #: Card rows ``(Item, verification state, publish time)`` of visible documents.
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
        newest = await self._newest_unread(recent_cards, viewed)
        popular = await self._load(self._popular())
        recently_published = await self._load(
            self._card_rows()
            .where(self._published_documents())
            .order_by(PUBLISH_TIME.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        await self._ctx.authorizer.ancestries(self._rows)
        popular_cards = await self._cards_of(popular)
        topics = await topic_summaries(
            self._session,
            self._ctx.authorizer,
            self._ctx.principal,
            self._workspace_id,
            limit=SECTION_LIMIT,
        )
        collection_count, document_count = await self._counts()
        return MemberHomeRecord(
            owner_workspace_id=self._workspace_id,
            owner_user_id=self._owner.user_id,
            counts=HomeCounts(
                collection_count=collection_count,
                document_count=document_count,
                saved_item_count=len(saved),
                topic_count=await topic_count(self._session, self._workspace_id),
                unread_notification_count=await unread_count(
                    self._session, self._ctx, self._owner, self._visibility
                ),
            ),
            suggested_questions=await self._suggested_questions(),
            topic_domains=tuple(
                HomeTopicDomain(
                    domain=self._topic(domain),
                    top_topics=tuple(self._topic(topic) for topic in domain.top_topics),
                )
                for domain in topics
            ),
            collections=collections,
            featured=self._featured(popular_cards),
            recently_published=tuple(await self._cards_of(recently_published)),
            recommended=await self._recommended(recent_cards, viewed, newest, popular_cards),
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

    async def _suggested_questions(self) -> tuple[str, ...]:
        """Starter prompts of the assistant meant for every member or one of the caller's roles."""
        settings = await assistant_settings(self._session, self._workspace_id)
        questions: list[str] = []
        for prompt in settings.starter_prompts:
            if not prompt.roles or await self._holds_any(prompt.roles):
                questions.append(prompt.prompt)
        return tuple(dict.fromkeys(questions))[:SECTION_LIMIT]

    @staticmethod
    def _featured(popular: Sequence[HomeItem]) -> tuple[HomeFeatured, ...]:
        """The most viewed readable documents."""
        return tuple(
            HomeFeatured(item=card, position=position)
            for position, card in enumerate(popular[:SECTION_LIMIT])
        )

    async def _newest_unread(
        self, recent: Sequence[HomeItem], viewed: set[UUID]
    ) -> list[UUID]:
        """Loads the newest unread published documents of each collection the member
        read (at most :data:`SECTION_LIMIT` each) in one windowed query."""
        reads = {read.collection_id for read in recent if read.collection_id is not None}
        if not reads:
            return []
        rank = (
            func.row_number()
            .over(partition_by=Item.parent_item_id, order_by=(Item.created_at.desc(), Item.id))
            .label("rank")
        )
        newest = (
            select(Item.id.label("item_id"), rank)
            .where(
                self._published_documents(),
                Item.parent_item_id.in_(reads),
                Item.id.not_in(viewed) if viewed else true(),
            )
            .subquery()
        )
        return await self._load(
            self._card_rows()
            .join(newest, newest.c.item_id == Item.id)
            .where(newest.c.rank <= SECTION_LIMIT)
            .order_by(Item.parent_item_id, newest.c.rank)
        )

    async def _recommended(
        self,
        recent: Sequence[HomeItem],
        viewed: set[UUID],
        newest: Sequence[UUID],
        popular: Sequence[HomeItem],
    ) -> tuple[HomeRecommended, ...]:
        """Unread documents next to what the member read (BECAUSE_YOU_READ), then POPULAR.

        Each read collection (first read first) contributes its ``newest`` unread documents.
        """
        recommended: list[HomeRecommended] = []
        shown = set(viewed)
        reads: dict[UUID, HomeItem] = {}
        for read in recent:
            if read.collection_id is not None:
                reads.setdefault(read.collection_id, read)
        by_collection: dict[UUID, list[HomeItem]] = {}
        for card in await self._cards_of(newest):
            by_collection.setdefault(self._rows[card.item_id][0].parent_item_id, []).append(card)
        for collection_id, read in reads.items():
            for card in by_collection.get(collection_id, ()):
                shown.add(card.item_id)
                recommended.append(
                    HomeRecommended(
                        item=card,
                        reason_kind="BECAUSE_YOU_READ",
                        reason_label=f"Because you read {read.display_name}",
                    )
                )
            if len(recommended) >= SECTION_LIMIT:
                break
        for card in popular:
            if card.item_id not in shown:
                shown.add(card.item_id)
                recommended.append(
                    HomeRecommended(item=card, reason_kind="POPULAR", reason_label="Popular")
                )
        return tuple(recommended[:SECTION_LIMIT])

    def _popular(self) -> Select[Any]:
        """Readable published documents most viewed by members over :data:`POPULAR_WINDOW`."""
        since = datetime.now(UTC) - POPULAR_WINDOW
        return (
            self._card_rows()
            .join(RecentItem, RecentItem.item_id == Item.id)
            .where(
                self._published_documents(),
                RecentItem.tenant_id == self._workspace_id,
                RecentItem.viewed_at >= since,
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

    def _card_rows(self) -> Select[Any]:
        return select(Item, VERIFICATION_STATE, PUBLISH_TIME)

    async def _load(self, statement: Select[Any]) -> list[UUID]:
        """Run a card-row query (visible documents only); returns the item IDs in order."""
        rows = (await self._session.execute(statement)).all()
        for row in rows:
            self._rows[row[0].id] = row
        return [row[0].id for row in rows]

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
            item, verification_state, publish_time = row
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

    async def _holds_any(self, roles: Iterable[str]) -> bool:
        for role in roles:
            scope = _role_scope(role, self._workspace_id)
            if scope is None:
                continue
            held = await self._session.scalar(
                select(TenantMembership.user_id).where(
                    TenantMembership.tenant_id == self._workspace_id,
                    TenantMembership.user_id == self._owner.user_id,
                    TenantMembership.deleted_at.is_(None),
                    holds_role(*scope),
                )
            )
            if held is not None:
                return True
        return False

    def _topic(self, summary: TopicSummary | TopicDomainSummary) -> HomeTopic:
        return HomeTopic(
            workspace_id=self._workspace_id,
            code=summary.code,
            display_name=summary.display_name,
            document_count=summary.document_count,
        )


def _role_scope(role: str, workspace_id: UUID) -> tuple[UUID | None, str] | None:
    """``(role_tenant_id, code)`` of ``roles/{r}`` or ``workspaces/{w}/roles/{r}``."""
    parts = role.split("/")
    if len(parts) == 2 and parts[0] == "roles":
        return None, parts[1]
    if len(parts) == 4 and parts[:3] == ["workspaces", str(workspace_id), "roles"]:
        return workspace_id, parts[3]
    return None


__all__ = ["POPULAR_WINDOW", "SECTION_LIMIT", "Covers", "MemberHomeService"]
