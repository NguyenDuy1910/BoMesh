"""What every Knowledge item use case shares: dependencies, loading and projection."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh import etag as etags
from bomesh.db.engine import SessionFactory
from bomesh.db.models import Item, ItemLink, ItemTopic, ItemUpload, Topic
from bomesh.document_index import ItemIndex
from bomesh.errors import (
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import ItemRef, not_found, permission_denied
from bomesh.iam.visibility import ItemVisibility, require_visible_item
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.retention import purge_time
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.knowledge_items.indexing import ItemIngestionService
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_KINDS,
    ItemService,
    catalog_visibility,
    has_open_contribution,
    in_subtree,
    is_personal,
    purpose,
)
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.knowledge_items.preview import KnowledgePreview, parse_manifest
from bomesh.services.knowledge_items.records import (
    Ancestor,
    CollectionFacet,
    DocumentFacet,
    ItemRecord,
    Origin,
    Verification,
)
from bomesh.services.knowledge_items.spaces import space_name_of
from bomesh.storage import DocumentStorage

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

READ = "items.get"
EDIT = "items.update"
OWN = "items.setIamPolicy"


@dataclass(frozen=True, slots=True)
class KnowledgeDeps:
    """Infrastructure the Knowledge item services use, taken from the runtime."""

    sessions: SessionFactory
    storage: DocumentStorage
    index: ItemIndex
    preview: KnowledgePreview
    payloads: ItemIngestionService
    processing_version: Callable[[], str]
    request_hash_secret: bytes
    max_upload_bytes: int
    upload_url_seconds: int
    download_url_seconds: int

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> KnowledgeDeps:
        sessions = runtime.sessions()
        index = runtime.item_index()
        return cls(
            sessions=sessions,
            storage=runtime.object_storage(),
            index=index,
            preview=runtime.knowledge_preview(),
            payloads=ItemIngestionService(sessions, index=index),
            processing_version=runtime.processing_version,
            request_hash_secret=runtime.request_hash_secret(),
            max_upload_bytes=runtime.config.upload.max_upload_bytes,
            upload_url_seconds=runtime.config.upload.upload_url_seconds,
            download_url_seconds=runtime.config.preview.url_seconds,
        )

    @property
    def workspaces(self) -> WorkspaceResolver:
        return WorkspaceResolver(self.sessions)


# -- Loading ------------------------------------------------------------------


async def load_item(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    item_id: UUID,
    *,
    permission: str = READ,
    include_deleted: bool = False,
    reviewer_exception: bool = False,
    for_update: bool = False,
) -> Item:
    """An item of the items API the caller holds ``permission`` on (AIP-211 otherwise).

    Items of the hidden artifacts collection answer like absent ones.
    """
    ref = ItemRef(workspace_id, item_id)
    item = await require_visible_item(
        session,
        ctx.authorizer,
        ctx.principal,
        ref,
        permission=permission,
        include_deleted=include_deleted,
        reviewer_exception=reviewer_exception,
        for_update=for_update,
    )
    if await is_hidden_item(ctx, item_id):
        raise await absent(ctx, ref, permission)
    return item


async def load_content_source(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    item_id: UUID,
    *,
    reviewer_exception: bool = False,
) -> Item:
    """An item whose content is about to be served: DELETED ones are NOT_FOUND.

    A caller who may see the DELETED item (``items.undelete``) learns that it
    exists through GetItem, but its content, passages and bytes are never served.
    """
    item = await load_item(
        session,
        ctx,
        workspace_id,
        item_id,
        include_deleted=True,
        reviewer_exception=reviewer_exception,
    )
    if item.deleted_at is not None:
        raise not_found(ItemRef(workspace_id, item_id))
    return item


async def load_referenced(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    item_id: UUID,
    *,
    permission: str,
    include_deleted: bool = False,
) -> Item:
    """An item a request names in a field: unreadable is always PERMISSION_DENIED."""
    try:
        return await load_item(
            session,
            ctx,
            workspace_id,
            item_id,
            permission=permission,
            include_deleted=include_deleted,
        )
    except NotFound:
        raise permission_denied(permission, ItemRef(workspace_id, item_id)) from None


async def is_hidden_item(ctx: RequestContext, item_id: UUID) -> bool:
    return any(node.system_kind in HIDDEN_KINDS for node in await ctx.authorizer.ancestry(item_id))


async def absent(ctx: RequestContext, ref: ItemRef, permission: str) -> NotFound | PermissionDenied:
    if permission in await ctx.authorizer.workspace_permissions(ctx.principal, ref.workspace_id):
        return not_found(ref)
    return permission_denied(permission, ref)


def item_etag(item: Item) -> str:
    return etags.compute(item_name(item.tenant_id, item.id), item.updated_at)


def check_etag(item: Item, expected: str | None) -> None:
    etags.check(expected, item_etag(item))


def require_document(item: Item, *, error: type[InvalidArgument | FailedPrecondition] = InvalidArgument) -> None:
    if item.item_type != "document":
        raise error("This method applies to DOCUMENT items only.")


async def require_no_open_contribution(session: AsyncSession, item: Item) -> None:
    if await has_open_contribution(session, item.id):
        raise FailedPrecondition(
            "A contribution on this item is open; its content cannot change.",
            reason="CONTRIBUTION_OPEN",
        )


async def governing_collection(session: AsyncSession, item: Item) -> Item | None:
    """The nearest COLLECTION of the item's canonical path (the item itself for one)."""
    current: Item | None = item
    while current is not None and current.item_type != "collection":
        current = (
            await session.get(Item, current.parent_item_id)
            if current.parent_item_id is not None
            else None
        )
    return current


async def boundary_of(ctx: RequestContext, item_id: UUID) -> UUID | None:
    """The access boundary governing ``item_id``: its first non-inheriting collection."""
    for node in await ctx.authorizer.ancestry(item_id):
        if not node.inherit_access:
            return node.item_id
    return None


# -- Projection -----------------------------------------------------------------

_CONTENT_STATES = {"pending": "PENDING", "ready": "AVAILABLE", "failed": "FAILED"}
_INDEXING_STATES = {
    "pending": "PENDING",
    "processing": "RUNNING",
    "ready": "SUCCEEDED",
    "failed": "FAILED",
    "unsupported": "UNSUPPORTED",
}


def indexing_state(item: Item, processing_version: str) -> str:
    state = _INDEXING_STATES.get(item.index_status or "pending", "PENDING")
    if state == "SUCCEEDED" and item.processed_version != processing_version:
        return "OUTDATED"
    return state


def verification(item: Item, now: datetime) -> Verification:
    value = item.metadata_.get("verification")
    if not isinstance(value, Mapping) or value.get("state") != "verified":
        return Verification(state="UNVERIFIED")
    next_review = _time(value.get("next_review_at"))
    return Verification(
        state="REVIEW_DUE" if next_review is not None and next_review <= now else "VERIFIED",
        verifier_id=_uuid(value.get("verifier_user_id")),
        verify_time=_time(value.get("verified_at")),
        next_review_time=next_review,
    )


def origin(item: Item) -> Origin | None:
    source = item.metadata_.get("source")
    if not isinstance(source, Mapping):
        return None
    return Origin(
        source_code=_text(source.get("source_code")),
        external_uri=_text(source.get("url")),
        path=_text(source.get("path")),
        source_update_time=_time(source.get("updated_at")),
    )


class Projector:
    """Turn rows into :class:`ItemRecord` for one caller in one workspace."""

    def __init__(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        deps: KnowledgeDeps,
        *,
        visibility: ItemVisibility,
    ) -> None:
        self._session = session
        self._ctx = ctx
        self._workspace_id = workspace_id
        self._deps = deps
        self._visibility = visibility
        self._processing_version: str | None = None

    @classmethod
    async def open(
        cls, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, deps: KnowledgeDeps
    ) -> Projector:
        visibility = await catalog_visibility(session, ctx.authorizer, ctx.principal, workspace_id)
        return cls(session, ctx, workspace_id, deps, visibility=visibility)

    async def project(self, item: Item, *, full: bool = False) -> ItemRecord:
        held = await self._ctx.authorizer.collection_permissions(
            self._ctx.principal, item.id, include_deleted=item.deleted_at is not None
        )
        record = ItemRecord(
            workspace_id=item.tenant_id,
            item_id=item.id,
            item_type=item.item_type.upper(),
            display_name=item.title,
            parent_id=item.parent_item_id,
            parent_relation=item.parent_relation.upper() if item.parent_relation else None,
            access=_access(held),
            state="DELETED" if item.deleted_at is not None else "ACTIVE",
            creator_id=item.created_by_user_id,
            create_time=item.created_at,
            update_time=item.updated_at,
            delete_time=item.deleted_at,
            purge_time=purge_time(item.deleted_at),
            ancestors=await self.ancestors(item) if full else None,
            collection=(
                await self._collection(item) if item.item_type == "collection" else None
            ),
            document=(
                await self._document(item, editor=EDIT in held)
                if item.item_type == "document"
                else None
            ),
        )
        return record

    async def locked(self, item: Item) -> ItemRecord:
        """The LOCKED projection of a discoverable root the caller cannot read."""
        return ItemRecord(
            workspace_id=item.tenant_id,
            item_id=item.id,
            item_type="COLLECTION",
            display_name=item.title,
            parent_id=None,
            parent_relation=None,
            access="LOCKED",
            state="ACTIVE",
            creator_id=None,
            create_time=item.created_at,
            update_time=item.updated_at,
            delete_time=None,
            purge_time=None,
            collection=CollectionFacet(
                kind="STANDARD",
                owner_id=None,
                owner_summary=_text(item.metadata_.get("owner_summary")),
                description=_text(item.metadata_.get("description")),
                inherit_access=False,
                discoverable=True,
                accepts_contributions=False,
                space=None,
                child_count=None,
                document_count=None,
                link_count=None,
            ),
        )

    async def ancestors(self, item: Item) -> tuple[Ancestor, ...]:
        """Root-first collections the caller can read, plus discoverable roots."""
        path = (await self._ctx.authorizer.ancestry(item.id))[1:]
        shown: list[UUID] = []
        for node in reversed(path):
            if node.item_type != "collection" or node.system_kind in HIDDEN_KINDS:
                continue
            held = await self._ctx.authorizer.collection_permissions(
                self._ctx.principal, node.item_id, include_deleted=True
            )
            if READ in held or node.parent_item_id is None:
                shown.append(node.item_id)
        if not shown:
            return ()
        rows = {
            row.id: row
            for row in await self._session.scalars(select(Item).where(Item.id.in_(shown)))
        }
        return tuple(
            Ancestor(item_id=identifier, display_name=rows[identifier].title)
            for identifier in shown
            if identifier in rows
            and (
                rows[identifier].parent_item_id is not None
                or rows[identifier].metadata_.get("discoverable") is True
                or rows[identifier].id in self._visibility.readable
            )
        )

    async def _collection(self, item: Item) -> CollectionFacet:
        personal = is_personal(item)
        live = item.deleted_at is None
        return CollectionFacet(
            kind="PERSONAL" if personal else "STANDARD",
            owner_id=item.created_by_user_id if personal else None,
            owner_summary=_text(item.metadata_.get("owner_summary")),
            description=_text(item.metadata_.get("description")),
            inherit_access=item.inherit_access,
            discoverable=item.metadata_.get("discoverable") is True,
            accepts_contributions=item.metadata_.get("accepts_contributions") is True,
            space=(
                await space_name_of(self._session, item.tenant_id, item.space_id)
                if item.space_id is not None
                else None
            ),
            child_count=await self._count(
                select(Item.id).where(Item.parent_item_id == item.id, self._visibility.clause())
            )
            if live
            else None,
            document_count=await self._count(
                select(Item.id).where(
                    Item.item_type == "document",
                    Item.publication_state == "published",
                    in_subtree(Item.id, item.id),
                    self._visibility.clause(),
                )
            )
            if live
            else None,
            link_count=await self._count(visible_links(self._visibility, item.id)) if live else None,
        )

    async def _document(self, item: Item, *, editor: bool) -> DocumentFacet:
        revision = await ItemService(self._session).current_revision(item.id)
        topics = tuple(
            await self._session.scalars(
                select(Topic.code)
                .join(ItemTopic, ItemTopic.topic_id == Topic.id)
                .where(ItemTopic.item_id == item.id)
                .order_by(Topic.code)
            )
        )
        if self._processing_version is None:
            self._processing_version = self._deps.processing_version()
        now = await self._session.scalar(select(func.now()))
        assert now is not None
        return DocumentFacet(
            file_name=_text(item.metadata_.get("file_name")),
            mime_type=item.mime_type,
            size_bytes=item.size_bytes,
            purpose=purpose(item).upper(),
            document_type=item.document_type,
            topics=topics,
            summary=_text(item.metadata_.get("summary")),
            language_code=_text(item.metadata_.get("language")),
            owner_id=_uuid(item.metadata_.get("owner_user_id")),
            content_state=_CONTENT_STATES.get(item.status, "PENDING"),
            publication_state=(item.publication_state or "published").upper(),
            indexing_state=indexing_state(item, self._processing_version),
            revision=revision.revision_number if revision is not None else None,
            indexed_revision=item.indexed_revision_number,
            verification=verification(item, now),
            origin=origin(item),
            merged_into=_uuid(item.metadata_.get("merged_into")),
            upload_uri=await self._upload_uri(item),
            thumbnail_uri=thumbnail_uri(
                self._deps.preview, item, expires_seconds=self._deps.download_url_seconds
            ),
            editor=editor,
        )

    async def _upload_uri(self, item: Item) -> str | None:
        if item.status != "pending" or item.storage_key is None or item.deleted_at is not None:
            return None
        owner = await self._session.scalar(
            select(ItemUpload.owner_user_id).where(ItemUpload.item_id == item.id)
        )
        if owner != self._ctx.user_id:
            return None
        return self._deps.storage.presign_upload(
            item.storage_key,
            content_type=item.mime_type or "application/octet-stream",
            expires_seconds=self._deps.upload_url_seconds,
        ).url

    async def _count(self, statement: Any) -> int:
        value = await self._session.scalar(select(func.count()).select_from(statement.subquery()))
        return int(value or 0)


#: The link's target and, when it was merged, the merge target (``visible_links``).
LINK_TARGET = aliased(Item, name="link_target")
LINK_MERGED = aliased(Item, name="link_merged")
#: The display name a link shows: its merge-resolved target's.
LINK_TARGET_TITLE = func.coalesce(LINK_MERGED.title, LINK_TARGET.title)


def thumbnail_uri(preview: KnowledgePreview, item: Item, *, expires_seconds: int) -> str | None:
    """The signed first page image of the current revision (``document.thumbnailUri``).

    ``None`` for a collection, a DELETED item, or a revision without page images.
    """
    if item.item_type != "document" or item.deleted_at is not None:
        return None
    manifest = parse_manifest(item.metadata_.get("preview"))
    if manifest is None:
        return None
    assets = preview.resolve_assets(item, manifest, expires_seconds=expires_seconds)
    first = min(assets, key=lambda asset: asset.page or 0, default=None)
    return first.url if first is not None else None


def visible_links(visibility: ItemVisibility, collection_id: UUID | None = None) -> Any:
    """``SELECT ItemLink, target, merged`` of live links whose merge-resolved target
    the visibility admits; a DELETED target that was not merged hides its link."""
    target, merged = LINK_TARGET, LINK_MERGED
    resolved = case((target.deleted_at.is_(None), target.id), else_=merged.id)
    statement = (
        select(ItemLink, target, merged)
        .join(target, target.id == ItemLink.target_item_id)
        .outerjoin(
            merged,
            and_(
                target.deleted_at.is_not(None),
                merged.id == func.cast(target.metadata_["merged_into"].astext, merged.id.type),
            ),
        )
        .where(
            ItemLink.deleted_at.is_(None),
            resolved.in_(select(Item.id).where(visibility.clause())),
        )
    )
    if collection_id is not None:
        statement = statement.where(ItemLink.collection_item_id == collection_id)
    return statement


def _access(held: frozenset[str]) -> str | None:
    if OWN in held:
        return "OWNER"
    if EDIT in held:
        return "EDITOR"
    if READ in held:
        return "READER"
    return None


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None


def _time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


__all__ = [
    "EDIT",
    "LINK_MERGED",
    "LINK_TARGET",
    "LINK_TARGET_TITLE",
    "OWN",
    "READ",
    "KnowledgeDeps",
    "Projector",
    "absent",
    "boundary_of",
    "check_etag",
    "governing_collection",
    "indexing_state",
    "is_hidden_item",
    "item_etag",
    "load_content_source",
    "load_item",
    "load_referenced",
    "origin",
    "require_document",
    "require_no_open_contribution",
    "thumbnail_uri",
    "verification",
    "visible_links",
]
