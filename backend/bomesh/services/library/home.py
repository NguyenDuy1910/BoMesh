"""``GetMemberHome``: the member's output-only Home read model.

Composed from other slices' public reads and bounded queries over items the
member can see (``catalog_visibility``): every section holds at most
:data:`SECTION_LIMIT` entries, only readable items appear (except LOCKED root
collections), merged documents resolve to their target and duplicates
collapse.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ColumnElement, and_, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, RecentItem, SavedItem, TenantMembership
from bomesh.iam.policy import PERSONAL_KIND
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.knowledge_curation.contributions import (
    member_contributions,
    review_queue_count,
)
from bomesh.services.knowledge_curation.reading_lists import (
    featured_item_ids,
    reading_list_summaries,
)
from bomesh.services.knowledge_curation.records import TopicDomainSummary, TopicSummary
from bomesh.services.knowledge_curation.topics import topic_count, topic_summaries
from bomesh.services.knowledge_items.content import item_thumbnail
from bomesh.services.knowledge_items.item_store import catalog_visibility
from bomesh.services.knowledge_items.items import KnowledgeItemService
from bomesh.services.knowledge_items.preview import KnowledgePreview
from bomesh.services.knowledge_items.queries import PUBLISH_TIME, VERIFICATION_STATE
from bomesh.services.library.access import LibraryGate, Owner
from bomesh.services.library.items import readable_references
from bomesh.services.library.notifications import unread_count
from bomesh.services.library.records import (
    HomeCollection,
    HomeContribution,
    HomeCounts,
    HomeFeatured,
    HomeItem,
    HomeReadingList,
    HomeRecommended,
    HomeTopic,
    HomeTopicDomain,
    ItemReference,
    MemberHomeRecord,
)
from bomesh.services.workspaces.members import holds_role
from bomesh.services.workspaces.settings import assistant_settings

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

SECTION_LIMIT = 8
#: Views counted for POPULAR entries.
POPULAR_WINDOW = timedelta(days=30)


@dataclass(frozen=True, slots=True)
class Thumbnails:
    """Where Home's signed page-image thumbnails come from."""

    preview: KnowledgePreview
    expires_seconds: int


class MemberHomeService:
    def __init__(
        self,
        sessions: SessionFactory,
        items: KnowledgeItemService,
        thumbnails: Thumbnails,
    ) -> None:
        self._sessions = sessions
        self._items = items
        self._thumbnails = thumbnails
        self._gate = LibraryGate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> MemberHomeService:
        return cls(
            runtime.sessions(),
            KnowledgeItemService.from_runtime(runtime),
            Thumbnails(runtime.knowledge_preview(), runtime.config.preview.url_seconds),
        )

    async def get(self, ctx: RequestContext, workspace_id: UUID, member: str) -> MemberHomeRecord:
        owner = await self._gate.open(ctx, workspace_id, member, "members.getHome", write=False)
        collections = await self._root_collections(ctx, workspace_id)
        async with transaction_scope(self._sessions) as session:
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
            composer = _Composer(session, ctx, owner, visibility, self._thumbnails)
            return await composer.compose(collections)

    async def _root_collections(
        self, ctx: RequestContext, workspace_id: UUID
    ) -> tuple[HomeCollection, ...]:
        """Root collections as ListItems shows them (LOCKED discoverable ones last), no PERSONAL."""
        page = await self._items.list(
            ctx,
            workspace_id,
            ListQuery(
                where=and_(
                    Item.item_type == "collection",
                    Item.parent_item_id.is_(None),
                    Item.metadata_["system_kind"].astext.is_distinct_from(PERSONAL_KIND),
                ),
                order_by=(Item.title.asc(), Item.id.asc()),
                offset=0,
                limit=SECTION_LIMIT,
            ),
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
            for record in page.items
        )


class _Composer:
    """One Home composition inside one read transaction."""

    def __init__(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        owner: Owner,
        visibility: ItemVisibility,
        thumbnails: Thumbnails,
    ) -> None:
        self._thumbnails = thumbnails
        self._session = session
        self._ctx = ctx
        self._owner = owner
        self._workspace_id = owner.workspace_id
        self._visibility = visibility

    async def compose(self, collections: tuple[HomeCollection, ...]) -> MemberHomeRecord:
        saved = await self._references(SavedItem.item_id, SavedItem.created_at, SavedItem)
        recent = await self._references(RecentItem.item_id, RecentItem.viewed_at, RecentItem)
        recent_cards = await self._cards(recent)
        viewed = {card.item_id for card in recent_cards}
        topics = await topic_summaries(
            self._session,
            self._ctx.authorizer,
            self._ctx.principal,
            self._workspace_id,
            limit=SECTION_LIMIT,
        )
        return MemberHomeRecord(
            owner_workspace_id=self._workspace_id,
            owner_user_id=self._owner.user_id,
            counts=HomeCounts(
                collection_count=await self._count(Item.item_type == "collection"),
                document_count=await self._count(
                    and_(Item.item_type == "document", Item.publication_state == "published")
                ),
                saved_item_count=len(saved),
                topic_count=await topic_count(self._session, self._workspace_id),
                unread_notification_count=await unread_count(self._session, self._ctx, self._owner),
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
            reading_lists=tuple(
                HomeReadingList(
                    workspace_id=self._workspace_id,
                    code=entry.code,
                    display_name=entry.display_name,
                    item_count=entry.item_count,
                )
                for entry in await reading_list_summaries(
                    self._session,
                    self._ctx.authorizer,
                    self._ctx.principal,
                    self._workspace_id,
                    limit=SECTION_LIMIT,
                )
            ),
            featured=await self._featured(),
            recently_published=await self._recently_published(),
            recommended=await self._recommended(recent_cards, viewed),
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

    async def _featured(self) -> tuple[HomeFeatured, ...]:
        """Curated entries of the featured reading list first, then popular documents."""
        curated = await self._resolved_cards(
            await featured_item_ids(
                self._session,
                self._ctx.authorizer,
                self._ctx.principal,
                self._workspace_id,
                limit=SECTION_LIMIT,
            )
        )
        shown = {card.item_id for card in curated}
        popular = [card for card in await self._popular() if card.item_id not in shown]
        entries = [(card, "CURATED") for card in curated] + [(card, "POPULAR") for card in popular]
        return tuple(
            HomeFeatured(item=card, position=position, source=source)
            for position, (card, source) in enumerate(entries[:SECTION_LIMIT])
        )

    async def _recently_published(self) -> tuple[HomeItem, ...]:
        ids = await self._session.scalars(
            select(Item.id)
            .where(self._published_documents())
            .order_by(PUBLISH_TIME.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        return tuple(await self._cards_of(list(ids)))

    async def _recommended(
        self, recent: Sequence[HomeItem], viewed: set[UUID]
    ) -> tuple[HomeRecommended, ...]:
        """Unread documents next to what the member read (BECAUSE_YOU_READ), then POPULAR."""
        recommended: list[HomeRecommended] = []
        shown = set(viewed)
        for read in recent:
            if read.collection_id is None:
                continue
            ids = await self._session.scalars(
                select(Item.id)
                .where(
                    self._published_documents(),
                    Item.parent_item_id == read.collection_id,
                    Item.id.not_in(shown) if shown else true(),
                )
                .order_by(Item.created_at.desc(), Item.id)
                .limit(SECTION_LIMIT)
            )
            for card in await self._cards_of(list(ids)):
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
        for card in await self._popular():
            if card.item_id not in shown:
                shown.add(card.item_id)
                recommended.append(
                    HomeRecommended(item=card, reason_kind="POPULAR", reason_label="Popular")
                )
        return tuple(recommended[:SECTION_LIMIT])

    async def _popular(self) -> list[HomeItem]:
        """Readable published documents most viewed by members over :data:`POPULAR_WINDOW`."""
        since = datetime.now(UTC) - POPULAR_WINDOW
        views = func.count(RecentItem.user_id)
        ids = await self._session.scalars(
            select(Item.id)
            .join(RecentItem, RecentItem.item_id == Item.id)
            .where(
                self._published_documents(),
                RecentItem.tenant_id == self._workspace_id,
                RecentItem.viewed_at >= since,
            )
            .group_by(Item.id)
            .order_by(views.desc(), Item.id)
            .limit(SECTION_LIMIT)
        )
        return await self._cards_of(list(ids))

    # -- Building blocks ------------------------------------------------------

    async def _references(
        self,
        entry: ColumnElement[UUID],
        moment: ColumnElement[datetime],
        model: type[SavedItem] | type[RecentItem],
    ) -> list[ItemReference]:
        rows = await self._session.execute(
            select(entry, moment)
            .where(model.tenant_id == self._workspace_id, model.user_id == self._owner.user_id)
            .order_by(moment.desc(), entry)
        )
        return await readable_references(
            self._session, self._ctx, self._owner, rows.tuples().all()
        )

    async def _cards(self, references: Iterable[ItemReference]) -> list[HomeItem]:
        """Document cards of resolved references, first occurrence kept."""
        merged = {ref.item_id: ref.merged_from for ref in references}
        return await self._cards_of(list(merged), merged)

    async def _resolved_cards(self, item_ids: Sequence[UUID]) -> list[HomeItem]:
        """Cards of referenced items after the reference rule (visibility, merges)."""
        now = datetime.now(UTC)
        return await self._cards(
            await readable_references(
                self._session, self._ctx, self._owner, [(item_id, now) for item_id in item_ids]
            )
        )

    async def _cards_of(
        self, item_ids: Sequence[UUID], merged_from: dict[UUID, UUID | None] | None = None
    ) -> list[HomeItem]:
        """Cards of the visible documents among ``item_ids``, in that order."""
        if not item_ids:
            return []
        rows = await self._session.execute(
            select(
                Item.id, Item.title, Item.document_type, VERIFICATION_STATE, PUBLISH_TIME
            ).where(
                Item.id.in_(item_ids), Item.item_type == "document", self._visibility.clause()
            )
        )
        found = {row[0]: row for row in rows}
        cards: list[HomeItem] = []
        for item_id in dict.fromkeys(item_ids):
            row = found.get(item_id)
            if row is None:
                continue
            cards.append(
                HomeItem(
                    workspace_id=self._workspace_id,
                    item_id=item_id,
                    merged_from=(merged_from or {}).get(item_id),
                    display_name=row[1],
                    collection_id=await self._ctx.authorizer.governing_collection(item_id),
                    document_type=row[2],
                    verification_state=row[3],
                    publish_time=row[4],
                    thumbnail_uri=await item_thumbnail(
                        self._session,
                        self._thumbnails.preview,
                        item_id,
                        expires_seconds=self._thumbnails.expires_seconds,
                    ),
                )
            )
        return cards

    def _published_documents(self) -> ColumnElement[bool]:
        return and_(
            Item.item_type == "document",
            Item.publication_state == "published",
            self._visibility.clause(),
        )

    async def _count(self, condition: ColumnElement[bool]) -> int:
        return int(
            await self._session.scalar(
                select(func.count(Item.id)).where(condition, self._visibility.clause())
            )
            or 0
        )

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


__all__ = ["POPULAR_WINDOW", "SECTION_LIMIT", "MemberHomeService", "Thumbnails"]
