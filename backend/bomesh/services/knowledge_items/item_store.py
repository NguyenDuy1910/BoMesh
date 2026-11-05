"""The Item domain engine: rows, tree lifecycle and revisions (``item_model.md``).

Everything here runs inside the caller's session and transaction and does
not authorize; the services of this package authorize and call it.
Other engines (ingestion, source sync, archives, artifacts) use it directly.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from sqlalchemy import ColumnElement, and_, func, literal, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from bomesh.connector.file import FinxFileExtensions
from bomesh.db.models import (
    Citation,
    Contribution,
    Conversation,
    Item,
    ItemLink,
    ItemRevision,
    ItemUpload,
    Message,
    MessageItem,
    Role,
    RoleAssignment,
)
from bomesh.db.models.knowledge import INDEX_STATUSES, OPEN_CONTRIBUTION_STATES
from bomesh.iam import ItemRef, Principal, WorkspaceAccess
from bomesh.iam.authorizer import Authorizer
from bomesh.iam.policy import PERSONAL_KIND
from bomesh.iam.visibility import ItemVisibility, item_visibility, require_visible_item
from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE as _NS
from bomesh.services import (
    ARTIFACT_COLLECTION_KIND,
    ARTIFACT_COLLECTION_TITLE,
    MESSAGE_ITEM_RELATIONS,
    DocumentNotFoundError,
    InvalidDocumentStateError,
)

#: The owner grant on a personal (or other owner-only system) collection.
COLLECTION_OWNER_ROLE = "collectionOwner"
PERSONAL_TITLE = "My files"

#: System collections the items API, search and ingestion never show.
HIDDEN_KINDS = (ARTIFACT_COLLECTION_KIND,)

PURPOSE_KNOWLEDGE = "knowledge"
PURPOSE_ATTACHMENT = "conversation_attachment"
ARCHIVE_DOCUMENT_TYPE = "archive"
ARCHIVE_MIME_TYPES = frozenset({"application/zip", "application/x-zip-compressed"})

#: Metadata derived from the current revision's object; reset when it changes.
_DERIVED_METADATA_KEYS = ("preview", "processing")


# -- Identity -----------------------------------------------------------------


def personal_collection_id(workspace_id: UUID, user_id: UUID) -> UUID:
    """The stable ID of a member's PERSONAL collection ("My files")."""
    return uuid5(NAMESPACE_URL, f"{_NS}:upload-collection:{workspace_id}:{user_id}")


def artifact_collection_id(workspace_id: UUID, user_id: UUID) -> UUID:
    """The stable ID of a member's hidden ``conversation_artifacts`` collection."""
    return uuid5(NAMESPACE_URL, f"{_NS}:artifact-collection:{workspace_id}:{user_id}")


def revision_object_key(workspace_id: UUID, item_id: UUID, revision_number: int) -> str:
    """Object key of a revision's original; never rewritten, reused by rollbacks."""
    return f"tenants/{workspace_id}/items/{item_id}/revisions/{revision_number}/original"


def new_revision_object_key(workspace_id: UUID, item_id: UUID) -> str:
    """A fresh object key for one upload: concurrent uploads never overwrite each other."""
    return f"tenants/{workspace_id}/items/{item_id}/revisions/{uuid4()}/original"


# -- Facets read from rows -------------------------------------------------------


def system_kind(item: Item) -> str | None:
    value = item.metadata_.get("system_kind")
    return value if isinstance(value, str) else None


def is_personal(item: Item) -> bool:
    return item.item_type == "collection" and system_kind(item) == PERSONAL_KIND


def is_hidden(item: Item) -> bool:
    return item.item_type == "collection" and system_kind(item) in HIDDEN_KINDS


def purpose(item: Item) -> str:
    value = item.metadata_.get("purpose")
    return value if value in (PURPOSE_KNOWLEDGE, PURPOSE_ATTACHMENT) else PURPOSE_KNOWLEDGE


def is_source_managed(item: Item) -> bool:
    return isinstance(item.metadata_.get("source"), Mapping)


def file_extension(file_name: str) -> str:
    return PurePosixPath(file_name).suffix.casefold()


def is_image(file_name: str, mime_type: str) -> bool:
    return mime_type.startswith("image/") or (
        file_extension(file_name) in FinxFileExtensions.IMAGE_EXTENSIONS
    )


def is_archive(file_name: str, mime_type: str) -> bool:
    return mime_type in ARCHIVE_MIME_TYPES or file_extension(file_name) == ".zip"


def is_knowledge_format(file_name: str) -> bool:
    return file_extension(file_name) in FinxFileExtensions.KNOWLEDGE_EXTENSIONS


def document_type_for_content_type(content_type: str) -> str:
    """The semantic document type of an upload, from its normalized MIME type."""
    if content_type in ARCHIVE_MIME_TYPES:
        return ARCHIVE_DOCUMENT_TYPE
    if content_type.startswith("image/"):
        return "image"
    if content_type == "application/pdf":
        return "pdf"
    if content_type in {"text/html", "application/xhtml+xml"}:
        return "web_page"
    if content_type in {"text/markdown", "text/x-markdown"}:
        return "markdown"
    if content_type.startswith("audio/"):
        return "audio"
    if content_type.startswith("video/"):
        return "video"
    return "plain_text"


# -- Visibility for the items API ---------------------------------------------------


def hidden_collections(workspace_id: UUID) -> Any:
    """``SELECT id`` of the workspace's hidden system collections."""
    return select(Item.id).where(
        Item.tenant_id == workspace_id,
        Item.item_type == "collection",
        Item.metadata_["system_kind"].astext.in_(HIDDEN_KINDS),
    )


async def catalog_visibility(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    workspace_id: UUID,
    *,
    show_deleted: bool = False,
) -> ItemVisibility:
    """The visibility rule without the hidden system collections (``item_model.md`` §4.5).

    Lists, search, counts, links and retrieval all use this one predicate.
    """
    visibility = await item_visibility(
        authorizer, principal, workspace_id, show_deleted=show_deleted
    )
    hidden = frozenset(await session.scalars(hidden_collections(workspace_id)))
    if not hidden:
        return visibility
    return replace(
        visibility,
        readable=visibility.readable - hidden,
        editable=visibility.editable - hidden,
        restorable=visibility.restorable - hidden,
        restorable_editable=visibility.restorable_editable - hidden,
    )


async def visible_item_ids(
    session: AsyncSession, visibility: ItemVisibility, item_ids: Iterable[UUID]
) -> frozenset[UUID]:
    """The subset of ``item_ids`` the visibility admits: the PostgreSQL hit re-check."""
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return frozenset()
    return frozenset(
        await session.scalars(select(Item.id).where(Item.id.in_(ids), visibility.clause()))
    )


def descendants(item_id: UUID, *, live: bool = True) -> Any:
    """CTE of the item and every descendant (``id`` column), canonical tree only."""
    seed = select(Item.id).where(Item.id == item_id)
    if live:
        seed = seed.where(Item.deleted_at.is_(None))
    tree = seed.cte(f"subtree_{uuid4().hex[:8]}", recursive=True)
    child = aliased(Item)
    step = select(child.id).where(child.parent_item_id == tree.c.id)
    if live:
        step = step.where(child.deleted_at.is_(None))
    return tree.union_all(step)


def in_subtree(column: ColumnElement[Any], root_id: UUID) -> ColumnElement[bool]:
    """``column`` names a live strict descendant of ``root_id`` (the ``ancestors:`` filter)."""
    tree = descendants(root_id)
    return and_(column.in_(select(tree.c.id)), column != root_id)


async def collection_subtree(
    session: AsyncSession, workspace_id: UUID, roots: Iterable[UUID]
) -> frozenset[UUID]:
    """The live collections at or below ``roots`` (conversation and search scopes)."""
    result: set[UUID] = set()
    for root in dict.fromkeys(roots):
        tree = descendants(root)
        result.update(
            await session.scalars(
                select(Item.id).where(
                    Item.id.in_(select(tree.c.id)),
                    Item.tenant_id == workspace_id,
                    Item.item_type == "collection",
                )
            )
        )
    return frozenset(result)


async def has_open_contribution(session: AsyncSession, item_id: UUID) -> bool:
    """Whether ``item_id`` is the candidate of an open contribution (frozen content)."""
    return (
        await session.scalar(
            select(Contribution.id).where(
                Contribution.item_id == item_id,
                Contribution.state.in_(OPEN_CONTRIBUTION_STATES),
                Contribution.deleted_at.is_(None),
            )
        )
        is not None
    )


async def is_source_candidate(session: AsyncSession, item_id: UUID) -> bool:
    """Whether ``item_id`` is the candidate of a SOURCE contribution (source-managed)."""
    return (
        await session.scalar(
            select(Contribution.id).where(
                Contribution.item_id == item_id,
                Contribution.origin == "source",
                Contribution.deleted_at.is_(None),
            )
        )
        is not None
    )


@dataclass(frozen=True, slots=True)
class Cohort:
    """Items one Delete stamps (or one Undelete restores) with one ``deleted_at``."""

    items: tuple[Item, ...]

    @property
    def ids(self) -> tuple[UUID, ...]:
        return tuple(item.id for item in self.items)

    @property
    def document_ids(self) -> tuple[UUID, ...]:
        return tuple(item.id for item in self.items if item.item_type == "document")

    def boundaries(self, root: Item) -> tuple[Item, ...]:
        """Access-boundary collections inside the cohort other than ``root`` itself."""
        return tuple(
            item
            for item in self.items
            if item.item_type == "collection" and not item.inherit_access and item.id != root.id
        )


class ItemService:
    """Item rows, the tree lifecycle and revisions inside one session."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    # -- System collections ---------------------------------------------------

    async def ensure_personal_collection(self, workspace_id: UUID, user_id: UUID) -> UUID:
        """Create the member's PERSONAL collection on first use, idempotently.

        No workspace state check: it runs while a workspace is being created.
        """
        return await self.ensure_system_collection(
            workspace_id,
            user_id,
            collection_id=personal_collection_id(workspace_id, user_id),
            title=PERSONAL_TITLE,
            kind=PERSONAL_KIND,
        )

    async def ensure_system_collection(
        self,
        workspace_id: UUID,
        owner_user_id: UUID,
        *,
        collection_id: UUID,
        title: str,
        kind: str,
    ) -> UUID:
        """An owner-only root collection (``inherit_access`` false, one owner grant)."""
        await self._session.execute(
            insert(Item)
            .values(
                id=collection_id,
                tenant_id=workspace_id,
                item_type="collection",
                title=title,
                metadata_={"system_kind": kind},
                inherit_access=False,
                status="ready",
                created_by_user_id=owner_user_id,
            )
            .on_conflict_do_nothing(index_elements=[Item.id])
        )
        await self.grant_owner(collection_id, owner_user_id)
        return collection_id

    async def grant_owner(self, collection_id: UUID, user_id: UUID) -> None:
        """Give ``user_id`` the predefined ``collectionOwner`` role on a collection."""
        owner_role_id = await self._session.scalar(
            select(Role.id).where(
                Role.code == COLLECTION_OWNER_ROLE,
                Role.tenant_id.is_(None),
                Role.deleted_at.is_(None),
            )
        )
        if owner_role_id is None:
            raise InvalidDocumentStateError(
                "predefined roles are missing; run the IAM catalog sync"
            )
        await self._session.execute(
            insert(RoleAssignment)
            .values(
                user_id=user_id,
                role_id=owner_role_id,
                item_id=collection_id,
                created_by_user_id=user_id,
            )
            .on_conflict_do_nothing(
                index_elements=[
                    RoleAssignment.user_id,
                    RoleAssignment.group_id,
                    RoleAssignment.all_members,
                    RoleAssignment.tenant_id,
                    RoleAssignment.item_id,
                    RoleAssignment.space_id,
                    RoleAssignment.role_id,
                ],
                index_where=text("deleted_at IS NULL"),
            )
        )

    # -- Artifacts (Assistant) -----------------------------------------------

    async def create_artifact_item(
        self,
        workspace_id: UUID,
        owner_id: UUID,
        *,
        title: str,
        file_name: str,
        mime_type: str,
        metadata: Mapping[str, Any] | None = None,
        item_id: UUID | None = None,
    ) -> Item:
        """An artifact's DOCUMENT in the owner's hidden collection: pending, never processed."""
        collection_id = await self.ensure_system_collection(
            workspace_id,
            owner_id,
            collection_id=artifact_collection_id(workspace_id, owner_id),
            title=ARTIFACT_COLLECTION_TITLE,
            kind=ARTIFACT_COLLECTION_KIND,
        )
        item = Item(
            id=item_id or uuid4(),
            tenant_id=workspace_id,
            item_type="document",
            parent_item_id=collection_id,
            parent_relation="contains",
            document_type=document_type_for_content_type(mime_type),
            title=title,
            mime_type=mime_type,
            metadata_={**dict(metadata or {}), "file_name": file_name},
            status="pending",
            publication_state="published",
            index_status="unsupported",
            created_by_user_id=owner_id,
        )
        self._session.add(item)
        await self._session.flush()
        await self._session.refresh(item)
        return item

    async def set_item_state(
        self,
        item: Item,
        *,
        status: str | None = None,
        title: str | None = None,
        deleted: bool | None = None,
    ) -> None:
        """Content status, title or tombstone of an item without a subtree (an artifact)."""
        if status is not None:
            item.status = status
        if title is not None:
            item.title = title
        await self._session.flush()
        if deleted is True and item.deleted_at is None:
            await self.delete_cohort(Cohort((item,)))
        elif deleted is False and item.deleted_at is not None:
            await self.restore_cohort(Cohort((item,)), item.deleted_at)
        else:
            await self._session.refresh(item, attribute_names=["updated_at"])

    # -- Creation -------------------------------------------------------------

    async def create_collection(
        self,
        *,
        workspace_id: UUID,
        title: str,
        created_by_user_id: UUID | None,
        parent_item_id: UUID | None = None,
        inherit_access: bool = True,
        metadata: Mapping[str, Any] | None = None,
        space_id: UUID | None = None,
    ) -> Item:
        """A STANDARD collection; a root is always an access boundary."""
        item = Item(
            tenant_id=workspace_id,
            item_type="collection",
            parent_item_id=parent_item_id,
            parent_relation="contains" if parent_item_id is not None else None,
            title=title,
            metadata_=dict(metadata or {}),
            inherit_access=parent_item_id is not None and inherit_access,
            space_id=space_id,
            status="ready",
            created_by_user_id=created_by_user_id,
        )
        self._session.add(item)
        await self._session.flush()
        return item

    async def create_document(
        self,
        *,
        workspace_id: UUID,
        parent: Item,
        title: str,
        document_type: str,
        mime_type: str,
        size_bytes: int | None,
        file_name: str,
        purpose: str = PURPOSE_KNOWLEDGE,
        published: bool = True,
        created_by_user_id: UUID | None,
        metadata: Mapping[str, Any] | None = None,
        item_id: UUID | None = None,
        uploader_user_id: UUID | None = None,
    ) -> Item:
        """A DOCUMENT awaiting its bytes (``contentState`` PENDING, ``indexingState`` PENDING).

        ``uploader_user_id`` opens the private upload ledger; the bytes go to
        :func:`revision_object_key` of revision 1 and :meth:`mark_upload_available`
        records that revision. ``item_id`` makes creation idempotent (archive
        members): an existing row is returned unchanged.
        """
        identifier = item_id or uuid4()
        values = {
            "tenant_id": workspace_id,
            "item_type": "document",
            "parent_item_id": parent.id,
            "parent_relation": "contains" if parent.item_type == "collection" else "child",
            "document_type": document_type,
            "title": title,
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "storage_key": revision_object_key(workspace_id, identifier, 1),
            "metadata_": {**dict(metadata or {}), "file_name": file_name, "purpose": purpose},
            "status": "pending",
            "publication_state": "published" if published else "unpublished",
            "index_status": "pending",
            "created_by_user_id": created_by_user_id,
        }
        await self._session.execute(
            insert(Item)
            .values(id=identifier, **values)
            .on_conflict_do_nothing(index_elements=[Item.id])
        )
        if uploader_user_id is not None:
            await self._session.execute(
                insert(ItemUpload)
                .values(
                    item_id=identifier,
                    tenant_id=workspace_id,
                    owner_user_id=uploader_user_id,
                    status="pending",
                )
                .on_conflict_do_nothing(index_elements=[ItemUpload.item_id])
            )
        item = await self._session.get(Item, identifier, populate_existing=True)
        assert item is not None
        return item

    async def mark_upload_available(
        self,
        item: Item,
        *,
        size_bytes: int,
        processable: bool,
        storage_metadata: Mapping[str, Any] | None = None,
    ) -> Item:
        """The stored object validated: ``contentState`` AVAILABLE and revision 1.

        Nothing is processed here: a processable document waits ``pending``
        for an Ingestion Run; anything else is kept ``unsupported``.
        """
        upload = await self._session.get(ItemUpload, item.id, with_for_update=True)
        if upload is not None:
            upload.status = "available"
            upload.error_code = None
            upload.uploaded_at = datetime.now(UTC)
        item.status = "ready"
        item.size_bytes = size_bytes
        if storage_metadata:
            item.metadata_ = {**item.metadata_, "storage": dict(storage_metadata)}
        item.index_status = "pending" if processable else "unsupported"
        if await self.current_revision(item.id) is None:
            assert item.storage_key is not None and item.mime_type is not None
            self._session.add(
                ItemRevision(
                    item_id=item.id,
                    revision_number=1,
                    storage_key=item.storage_key,
                    mime_type=item.mime_type,
                    size_bytes=size_bytes,
                    created_by_user_id=upload.owner_user_id if upload else item.created_by_user_id,
                    exports=_revision_exports(item.metadata_.get("file_name")),
                )
            )
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return item

    async def mark_upload_failed(self, item: Item, *, error_code: str) -> Item:
        """The stored object did not validate: ``contentState`` FAILED."""
        upload = await self._session.get(ItemUpload, item.id, with_for_update=True)
        if upload is not None:
            upload.status = "failed"
            upload.error_code = error_code[:128]
        item.status = "failed"
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return item

    # -- Revisions ------------------------------------------------------------

    async def current_revision(self, item_id: UUID) -> ItemRevision | None:
        """The newest live revision: the content ``items.storage_key`` points at."""
        return await self._session.scalar(
            select(ItemRevision)
            .where(ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None))
            .order_by(ItemRevision.revision_number.desc())
            .limit(1)
        )

    async def revision(self, item_id: UUID, number: int) -> ItemRevision | None:
        return await self._session.scalar(
            select(ItemRevision).where(
                ItemRevision.item_id == item_id,
                ItemRevision.revision_number == number,
                ItemRevision.deleted_at.is_(None),
            )
        )

    async def append_revision(
        self,
        item: Item,
        *,
        storage_key: str,
        mime_type: str,
        size_bytes: int,
        file_name: str | None = None,
        created_by_user_id: UUID | None = None,
        external_version: str | None = None,
        contribution_id: UUID | None = None,
        restored_from: int | None = None,
        summary: str | None = None,
        author: str | None = None,
    ) -> ItemRevision:
        """Append revision n+1 and make it current (``item_model.md`` §4.8).

        The object is reused, never copied. ``storage_key``, ``mime_type``,
        ``size_bytes`` and ``metadata.file_name`` follow it, derived preview
        metadata is reset and the document waits for an Ingestion Run (one
        that is never processed, such as an artifact, stays ``unsupported``).
        ``author`` is set for artifact revisions only.
        """
        if item.item_type != "document":
            raise InvalidDocumentStateError("only documents have revisions")
        number = (
            await self._session.scalar(
                select(func.coalesce(func.max(ItemRevision.revision_number), 0)).where(
                    ItemRevision.item_id == item.id
                )
            )
            or 0
        ) + 1
        name = file_name or item.metadata_.get("file_name") or item.title
        revision = ItemRevision(
            item_id=item.id,
            revision_number=number,
            storage_key=storage_key,
            mime_type=mime_type,
            size_bytes=size_bytes,
            summary=summary,
            contribution_id=contribution_id,
            external_version=external_version,
            restored_from=restored_from,
            author=author,
            created_by_user_id=created_by_user_id,
            exports=_revision_exports(name),
        )
        self._session.add(revision)
        item.storage_key = storage_key
        item.mime_type = mime_type
        item.size_bytes = size_bytes
        item.status = "ready"
        metadata = {
            key: value
            for key, value in item.metadata_.items()
            if key not in _DERIVED_METADATA_KEYS
        }
        item.metadata_ = {**metadata, "file_name": name}
        if item.index_status != "unsupported":
            item.index_status = "pending"
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return revision

    async def live_revisions(
        self, item_id: UUID, *, offset: int = 0, limit: int | None = None
    ) -> list[ItemRevision]:
        """Live revisions, newest first."""
        statement = (
            select(ItemRevision)
            .where(ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None))
            .order_by(ItemRevision.revision_number.desc())
            .offset(offset)
        )
        if limit is not None:
            statement = statement.limit(limit)
        return list(await self._session.scalars(statement))

    async def count_live_revisions(self, item_id: UUID) -> int:
        count = await self._session.scalar(
            select(func.count()).where(
                ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None)
            )
        )
        return int(count or 0)

    async def delete_newest_revision(self, item: Item, number: int) -> ItemRevision:
        """Tombstone the newest live revision ``number``; the previous one becomes current."""
        live = await self.live_revisions(item.id, limit=2)
        if not live or live[0].revision_number != number:
            raise InvalidDocumentStateError("only the newest revision can be deleted")
        if len(live) < 2:
            raise InvalidDocumentStateError("the only revision cannot be deleted")
        newest, current = live
        newest.deleted_at = await self._now()
        item.storage_key = current.storage_key
        item.mime_type = current.mime_type
        item.size_bytes = current.size_bytes
        metadata = {
            key: value
            for key, value in item.metadata_.items()
            if key not in _DERIVED_METADATA_KEYS
        }
        preview = current.exports.get("preview")
        file_name = current.exports.get("file_name") or metadata.get("file_name")
        item.metadata_ = {
            **metadata,
            **({"file_name": file_name} if file_name else {}),
            **({"preview": preview} if preview else {}),
        }
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return current

    async def record_revision_preview(
        self, item_id: UUID, revision_number: int, manifest: Mapping[str, Any]
    ) -> None:
        """Store a revision's viewer manifest; mirror it on the item while current."""
        revision = await self.revision(item_id, revision_number)
        if revision is None:
            return
        revision.exports = {**revision.exports, "preview": dict(manifest)}
        current = await self.current_revision(item_id)
        if current is not None and current.revision_number == revision_number:
            item = await self._session.get(Item, item_id)
            if item is not None:
                item.metadata_ = {**item.metadata_, "preview": dict(manifest)}
        await self._session.flush()

    async def referenced_object_keys(
        self, keys: Iterable[str], *, purged_before: datetime
    ) -> frozenset[str]:
        """Keys still referenced by a live revision of an Item not deleted before ``purged_before``."""
        wanted = list(dict.fromkeys(keys))
        if not wanted:
            return frozenset()
        return frozenset(
            await self._session.scalars(
                select(ItemRevision.storage_key)
                .join(Item, Item.id == ItemRevision.item_id)
                .where(
                    ItemRevision.storage_key.in_(wanted),
                    ItemRevision.deleted_at.is_(None),
                    or_(Item.deleted_at.is_(None), Item.deleted_at > purged_before),
                )
            )
        )

    # -- Tree lifecycle -------------------------------------------------------

    async def live_subtree(self, item: Item) -> Cohort:
        """The item and every live descendant, locked (the cohort a Delete stamps)."""
        tree = descendants(item.id)
        rows = await self._session.scalars(
            select(Item).where(Item.id.in_(select(tree.c.id))).with_for_update()
        )
        return Cohort(tuple(rows))

    async def deleted_cohort(self, item: Item) -> Cohort:
        """The item and the descendants deleted with it (same ``deleted_at``), locked."""
        assert item.deleted_at is not None
        stamp = item.deleted_at
        seed = select(Item.id).where(Item.id == item.id).cte(
            f"cohort_{uuid4().hex[:8]}", recursive=True
        )
        child = aliased(Item)
        tree = seed.union_all(
            select(child.id).where(child.parent_item_id == seed.c.id, child.deleted_at == stamp)
        )
        rows = await self._session.scalars(
            select(Item).where(Item.id.in_(select(tree.c.id))).with_for_update()
        )
        return Cohort(tuple(rows))

    async def has_live_children(self, item_id: UUID) -> bool:
        return (
            await self._session.scalar(
                select(Item.id)
                .where(Item.parent_item_id == item_id, Item.deleted_at.is_(None))
                .limit(1)
            )
            is not None
        )

    async def delete_cohort(self, cohort: Cohort) -> datetime:
        """Stamp one ``deleted_at`` on the cohort, its links and citations; payloads dirty."""
        now = await self._now()
        ids = list(cohort.ids)
        await self._session.execute(
            update(Item)
            .where(Item.id.in_(ids))
            .values(deleted_at=now, payload_dirty_at=now, updated_at=now)
        )
        await self._session.execute(
            update(ItemLink)
            .where(ItemLink.collection_item_id.in_(ids), ItemLink.deleted_at.is_(None))
            .values(deleted_at=now, updated_at=now)
        )
        await self._session.execute(
            update(Citation)
            .where(Citation.item_id.in_(cohort.document_ids), Citation.deleted_at.is_(None))
            .values(deleted_at=now, updated_at=now)
        )
        await self._refresh(cohort.items)
        return now

    async def restore_cohort(self, cohort: Cohort, stamp: datetime) -> None:
        """Undo :meth:`delete_cohort` for exactly that cohort; ``merged_into`` is cleared."""
        now = await self._now()
        ids = list(cohort.ids)
        await self._session.execute(
            update(Item)
            .where(Item.id.in_(ids))
            .values(
                deleted_at=None,
                payload_dirty_at=now,
                updated_at=now,
                metadata_=Item.metadata_.op("-")(literal("merged_into")),
            )
        )
        restorable = await self._session.scalars(
            select(ItemLink).where(
                ItemLink.collection_item_id.in_(ids), ItemLink.deleted_at == stamp
            )
        )
        for link in restorable:
            if await self.live_link(link.collection_item_id, link.target_item_id) is None:
                link.deleted_at = None
                link.updated_at = now
        await self._session.execute(
            update(Citation)
            .where(Citation.item_id.in_(cohort.document_ids), Citation.deleted_at == stamp)
            .values(deleted_at=None, updated_at=now)
        )
        await self._session.flush()
        await self._refresh(cohort.items)

    async def move(self, item: Item, destination: Item | None) -> tuple[UUID, ...]:
        """Reparent ``item`` (``None`` = a new root); returns documents whose payload changes.

        A new root becomes an access boundary; a document moving into its
        owner's personal collection becomes PUBLISHED there; a live link of
        the destination to the item is deleted in the same transaction.
        """
        now = await self._now()
        item.parent_item_id = destination.id if destination is not None else None
        item.parent_relation = "contains" if destination is not None else None
        if destination is None:
            item.inherit_access = False
        if item.item_type == "document" and destination is not None and is_personal(destination):
            item.publication_state = "published"
        if destination is not None:
            link = await self.live_link(destination.id, item.id)
            if link is not None:
                link.deleted_at = now
                link.updated_at = now
        moved: tuple[UUID, ...] = ()
        if item.item_type == "document":
            tree = descendants(item.id)
            moved = tuple(
                await self._session.scalars(
                    select(Item.id).where(
                        Item.id.in_(select(tree.c.id)), Item.item_type == "document"
                    )
                )
            )
            await self._session.execute(
                update(Item).where(Item.id.in_(moved)).values(payload_dirty_at=now)
            )
        await self._session.flush()
        await self._session.refresh(item)
        return moved

    async def set_publication(self, item: Item, *, published: bool) -> None:
        item.publication_state = "published" if published else "unpublished"
        item.payload_dirty_at = await self._now()
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])

    async def live_link(self, collection_id: UUID, target_id: UUID) -> ItemLink | None:
        return await self._session.scalar(
            select(ItemLink).where(
                ItemLink.collection_item_id == collection_id,
                ItemLink.target_item_id == target_id,
                ItemLink.deleted_at.is_(None),
            )
        )

    # -- Engine maintenance ---------------------------------------------------

    async def merge_metadata(self, item_id: UUID, values: Mapping[str, Any]) -> Item:
        item = await self._get_internal(item_id)
        item.metadata_ = {**item.metadata_, **dict(values)}
        await self._session.flush()
        return item

    async def tombstone(self, item_id: UUID) -> Item:
        """Delete one item on the system's behalf (an expanded archive)."""
        item = await self._get_internal(item_id)
        await self.delete_cohort(Cohort((item,)))
        return item

    async def mark_index_pending(self, item_id: UUID) -> Item:
        """Content changed (or processing stopped short): the document awaits a run."""
        return await self._set_index_status(item_id, "pending")

    async def mark_index_processing(self, item_id: UUID) -> Item:
        return await self._set_index_status(item_id, "processing")

    async def mark_index_ready(
        self,
        item_id: UUID,
        *,
        processed_version: str,
        indexed_revision_number: int | None = None,
    ) -> Item:
        item = await self._set_index_status(item_id, "ready")
        item.processed_version = processed_version
        item.indexed_revision_number = indexed_revision_number
        await self._session.flush()
        return item

    async def mark_index_failed(self, item_id: UUID) -> Item:
        return await self._set_index_status(item_id, "failed")

    # -- Conversation references ----------------------------------------------

    async def get_item(
        self, item_id: UUID, *, access: WorkspaceAccess, permission: str = "items.get"
    ) -> Item:
        """An item the caller may see (visibility rule), hidden collections excluded."""
        item = await require_visible_item(
            self._session,
            access.authorizer,
            access.principal,
            ItemRef(access.workspace_id, item_id),
            permission=permission,
        )
        return item

    async def link_message(
        self,
        message_id: UUID,
        item_id: UUID,
        relation_type: str,
        *,
        access: WorkspaceAccess,
        position: int = 0,
    ) -> MessageItem:
        relation = relation_type.strip().casefold()
        if relation not in MESSAGE_ITEM_RELATIONS or position < 0:
            raise ValueError("invalid message-item relation")
        message_exists = await self._session.scalar(
            select(Message.id)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(
                Message.id == message_id,
                Conversation.tenant_id == access.workspace_id,
                Conversation.owner_user_id == access.user_id,
            )
        )
        if message_exists is None:
            raise DocumentNotFoundError(f"message not found: {message_id}")
        await self.get_item(item_id, access=access)
        link = await self._session.scalar(
            insert(MessageItem)
            .values(
                message_id=message_id,
                item_id=item_id,
                relation_type=relation,
                position=position,
            )
            .on_conflict_do_update(
                index_elements=[
                    MessageItem.message_id,
                    MessageItem.item_id,
                    MessageItem.relation_type,
                ],
                set_={"position": position, "deleted_at": None},
            )
            .returning(MessageItem)
        )
        if link is None:
            raise InvalidDocumentStateError("message-item link was not stored")
        return link

    # -- Internals ------------------------------------------------------------

    async def _set_index_status(self, item_id: UUID, status: str) -> Item:
        if status not in INDEX_STATUSES:
            raise ValueError(f"unsupported index status: {status}")
        item = await self._get_internal(item_id)
        if item.deleted_at is not None:
            raise InvalidDocumentStateError("cannot update a deleted item")
        if item.item_type != "document":
            raise InvalidDocumentStateError("only documents have an index lifecycle")
        item.index_status = status
        await self._session.flush()
        return item

    async def _get_internal(self, item_id: UUID) -> Item:
        item = await self._session.get(Item, item_id)
        if item is None:
            raise DocumentNotFoundError(f"item not found: {item_id}")
        return item

    async def _refresh(self, items: Sequence[Item]) -> None:
        for item in items:
            await self._session.refresh(item)

    async def _now(self) -> datetime:
        value = await self._session.scalar(select(func.now()))
        assert value is not None
        return value


def _revision_exports(file_name: object) -> dict[str, Any]:
    """``file_name`` travels with the revision so a rollback can restore it."""
    return {"file_name": file_name} if isinstance(file_name, str) and file_name else {}


async def ensure_personal_collection(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> UUID:
    """Create the member's PERSONAL collection if missing; returns its ID (idempotent)."""
    return await ItemService(session).ensure_personal_collection(workspace_id, user_id)


__all__ = [
    "ARCHIVE_DOCUMENT_TYPE",
    "COLLECTION_OWNER_ROLE",
    "HIDDEN_KINDS",
    "PERSONAL_TITLE",
    "PURPOSE_ATTACHMENT",
    "PURPOSE_KNOWLEDGE",
    "Cohort",
    "ItemService",
    "artifact_collection_id",
    "catalog_visibility",
    "collection_subtree",
    "descendants",
    "document_type_for_content_type",
    "ensure_personal_collection",
    "file_extension",
    "has_open_contribution",
    "hidden_collections",
    "in_subtree",
    "is_archive",
    "is_hidden",
    "is_image",
    "is_knowledge_format",
    "is_personal",
    "is_source_candidate",
    "is_source_managed",
    "new_revision_object_key",
    "personal_collection_id",
    "purpose",
    "revision_object_key",
    "system_kind",
    "visible_item_ids",
]
