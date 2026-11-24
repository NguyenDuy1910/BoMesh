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

from sqlalchemy import (
    ColumnElement,
    and_,
    exists,
    func,
    literal,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.orm.attributes import set_committed_value

from bomesh.connector.file import FinxFileExtensions
from bomesh.db.models import (
    Citation,
    Contribution,
    Conversation,
    ExternalResource,
    Item,
    ItemIndexState,
    ItemRevision,
    ItemShortcut,
    ItemUpload,
    Message,
    MessageItem,
    Role,
    RoleAssignment,
)
from bomesh.db.models.knowledge import INDEX_STATUSES, OPEN_CONTRIBUTION_STATES
from bomesh.iam import ItemRef, Principal, WorkspaceAccess
from bomesh.iam.authorizer import Authorizer
from bomesh.iam.policy import PERSONAL_COLLECTION_TYPE
from bomesh.iam.visibility import (
    ItemVisibility,
    below_document_reaching,
    item_visibility,
    require_visible_item,
)
from bomesh.identity import PERSISTED_IDENTITY_NAMESPACE as _NS
from bomesh.services import (
    ARTIFACT_COLLECTION_NAME,
    ARTIFACT_COLLECTION_TYPE,
    MESSAGE_ITEM_RELATIONS,
    DocumentNotFoundError,
    InvalidDocumentStateError,
)
from bomesh.services.knowledge_items.file_types import (
    file_class,
    processed_as_pdf,
    require_file_class,
)
from bomesh.storage.keys import content_key, new_content_id

#: The owner grant on a personal (or other owner-only system) collection.
COLLECTION_OWNER_ROLE = "collectionOwner"
PERSONAL_NAME = "My files"
STANDARD_COLLECTION_TYPE = "standard"

#: System collections the items API, search and ingestion never show.
HIDDEN_TYPES = (ARTIFACT_COLLECTION_TYPE,)

PURPOSE_KNOWLEDGE = "knowledge"
PURPOSE_ATTACHMENT = "conversation_attachment"

#: Exports a revision that reuses another revision's content takes over: they
#: describe products of the bytes (``bomesh.storage.keys`` derived keys).
_CONTENT_EXPORTS = ("representation", "representation_failure", "cover", "preview")
#: The read-only ``Item`` views of ``ItemIndexState`` that ``set_index_state`` writes.
_INDEX_VIEWS = frozenset({"index_status", "processed_version", "indexed_revision_number"})


# -- Identity -----------------------------------------------------------------


def personal_collection_id(workspace_id: UUID, user_id: UUID) -> UUID:
    """The stable ID of a member's PERSONAL collection ("My files")."""
    return uuid5(NAMESPACE_URL, f"{_NS}:upload-collection:{workspace_id}:{user_id}")


def artifact_collection_id(workspace_id: UUID, user_id: UUID) -> UUID:
    """The stable ID of a member's hidden ``conversation_artifacts`` collection."""
    return uuid5(NAMESPACE_URL, f"{_NS}:artifact-collection:{workspace_id}:{user_id}")


def item_content_key(item: Item) -> str:
    """The object key of the content a Document shows (its current revision or pending upload).

    Keys are never stored (``database_architecture.md`` "Object storage"); the
    rule needs the Item's tenant and the content identity.
    """
    content = item.content
    if content is None:
        raise InvalidDocumentStateError("the document has no content")
    return content_key(item.tenant_id, content.content_id)


def show_revision(item: Item, revision: ItemRevision) -> None:
    """Keep a loaded Item's content views on the revision it now shows.

    They are read-only column properties not expired on flush (like the
    index views :meth:`ItemService.set_index_state` keeps current).
    """
    set_committed_value(item, "content_state", "available")
    set_committed_value(item, "content_id", revision.content_id)
    set_committed_value(item, "mime_type", revision.mime_type)
    set_committed_value(item, "size_bytes", revision.size_bytes)
    set_committed_value(item, "file_name", revision.file_name)
    set_committed_value(item, "cover", revision.exports.get("cover"))


# -- Facets read from rows -------------------------------------------------------


def is_personal(item: Item) -> bool:
    return item.item_kind == "collection" and item.item_type == PERSONAL_COLLECTION_TYPE


def is_hidden(item: Item) -> bool:
    return item.item_kind == "collection" and item.item_type in HIDDEN_TYPES


def purpose(item: Item) -> str:
    return item.purpose or PURPOSE_KNOWLEDGE


async def is_source_managed(session: AsyncSession, item: Item) -> bool:
    """Whether a Source registered this Document (it has a provider identity)."""
    if item.item_kind != "document":
        return False
    return bool(
        await session.scalar(
            select(exists().where(ExternalResource.item_id == item.id))
        )
    )


def is_knowledge_format(file_name: str) -> bool:
    """Whether processing indexes the file: parsed as is, or through its PDF conversion."""
    suffix = PurePosixPath(file_name).suffix.casefold()
    return suffix in FinxFileExtensions.KNOWLEDGE_EXTENSIONS or processed_as_pdf(file_name)


# -- Visibility for the items API ---------------------------------------------------


def hidden_collections(workspace_id: UUID) -> Any:
    """``SELECT id`` of the workspace's hidden system collections."""
    return select(Item.id).where(
        Item.tenant_id == workspace_id,
        Item.item_kind == "collection",
        Item.item_type.in_(HIDDEN_TYPES),
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

    Lists, search, counts, shortcuts and retrieval all use this one predicate.
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


def collections_below(roots: Any, *, live: bool = True) -> Any:
    """CTE (``id``) of the items ``roots`` selects and every COLLECTION below them.

    Only collections have collection children, so the walk visits the
    collections of the subtree, never its documents (a document root is just itself).
    """
    root = aliased(Item, name="tree_root")
    seed = select(root.id).where(root.id.in_(roots))
    if live:
        seed = seed.where(root.deleted_at.is_(None))
    tree = seed.cte(f"collections_below_{uuid4().hex[:8]}", recursive=True)
    child = aliased(Item, name="tree_collection")
    step = select(child.id).where(
        child.parent_item_id == tree.c.id, child.item_kind == "collection"
    )
    if live:
        step = step.where(child.deleted_at.is_(None))
    return tree.union_all(step)


def in_tree(
    item: Any, roots: Any, workspace_id: Any, *, include_roots: bool, live: bool = True
) -> ColumnElement[bool]:
    """``item`` lies below one of the items ``roots`` selects (or is one, with
    ``include_roots``), canonical tree only; with ``live`` it and its path are live.

    Decided on the row: a collection by the subtree's collections
    (:func:`collections_below`), a document by its parent; only a document below
    another document climbs (:func:`below_document_reaching`).
    """
    walk = collections_below(roots, live=live)
    within = select(walk.c.id)
    branches = [
        and_(item.item_kind == "collection", item.id.in_(within)),
        and_(item.item_kind == "document", item.parent_item_id.in_(within)),
        and_(
            item.item_kind == "document",
            below_document_reaching(
                item, workspace_id, lambda node: node.c.id.in_(within), live=live
            ),
        ),
    ]
    if include_roots:
        branches.append(and_(item.item_kind == "document", item.id.in_(roots)))
    tree = or_(*branches)
    if not include_roots:
        tree = and_(tree, item.id.not_in(roots))
    return and_(item.deleted_at.is_(None), tree) if live else tree


def in_subtree(item: Any, root_id: UUID) -> ColumnElement[bool]:
    """``item`` is a live strict descendant of ``root_id`` (the ``ancestors:`` filter)."""
    root = aliased(Item, name="subtree_root")
    workspace = select(root.tenant_id).where(root.id == root_id).scalar_subquery()
    return in_tree(item, select(literal(root_id)), workspace, include_roots=False)


async def collection_subtree(
    session: AsyncSession, workspace_id: UUID, roots: Iterable[UUID]
) -> frozenset[UUID]:
    """The live collections at or below ``roots`` (conversation and search scopes)."""
    wanted = list(dict.fromkeys(roots))
    if not wanted:
        return frozenset()
    tree = collections_below(wanted)
    return frozenset(
        await session.scalars(
            select(Item.id).where(
                Item.id.in_(select(tree.c.id)),
                Item.tenant_id == workspace_id,
                Item.item_kind == "collection",
            )
        )
    )


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
        return tuple(item.id for item in self.items if item.item_kind == "document")

    def boundaries(self, root: Item) -> tuple[Item, ...]:
        """Access-boundary collections inside the cohort other than ``root`` itself."""
        return tuple(
            item
            for item in self.items
            if item.item_kind == "collection" and not item.inherit_access and item.id != root.id
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
            item_name=PERSONAL_NAME,
            item_type=PERSONAL_COLLECTION_TYPE,
        )

    async def ensure_system_collection(
        self,
        workspace_id: UUID,
        owner_user_id: UUID,
        *,
        collection_id: UUID,
        item_name: str,
        item_type: str,
    ) -> UUID:
        """An owner-only root collection (``inherit_access`` false, one owner grant)."""
        await self._session.execute(
            insert(Item)
            .values(
                id=collection_id,
                tenant_id=workspace_id,
                item_kind="collection",
                item_type=item_type,
                item_name=item_name,
                inherit_access=False,
                discoverable=False,
                accepts_contributions=False,
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
        item_name: str,
        mime_type: str,
        file_name: str,
        item_id: UUID | None = None,
    ) -> Item:
        """An artifact's DOCUMENT in the owner's hidden collection: pending, never processed.

        The owner is the Item's ``owner_user_id``; its file class is fixed here
        from the content the Artifact kind produces.
        """
        collection_id = await self.ensure_system_collection(
            workspace_id,
            owner_id,
            collection_id=artifact_collection_id(workspace_id, owner_id),
            item_name=ARTIFACT_COLLECTION_NAME,
            item_type=ARTIFACT_COLLECTION_TYPE,
        )
        item = Item(
            id=item_id or uuid4(),
            tenant_id=workspace_id,
            item_kind="document",
            item_type=file_class(mime_type, file_name),
            parent_item_id=collection_id,
            item_name=item_name,
            purpose=PURPOSE_KNOWLEDGE,
            is_published=True,
            owner_user_id=owner_id,
            created_by_user_id=owner_id,
        )
        self._session.add(item)
        await self._session.flush()
        await self.set_index_state((item,), index_status="unsupported")
        await self._session.refresh(item)
        return item

    async def set_item_state(
        self,
        item: Item,
        *,
        item_name: str | None = None,
        deleted: bool | None = None,
    ) -> None:
        """Name or tombstone of an item without a subtree (an artifact)."""
        if item_name is not None:
            item.item_name = item_name
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
        item_name: str,
        created_by_user_id: UUID | None,
        parent_item_id: UUID | None = None,
        inherit_access: bool = True,
        description: str | None = None,
        discoverable: bool = False,
        accepts_contributions: bool = False,
    ) -> Item:
        """A STANDARD collection; a root is always an access boundary."""
        item = Item(
            tenant_id=workspace_id,
            item_kind="collection",
            item_type=STANDARD_COLLECTION_TYPE,
            parent_item_id=parent_item_id,
            item_name=item_name,
            description=description,
            discoverable=discoverable,
            accepts_contributions=accepts_contributions,
            inherit_access=parent_item_id is not None and inherit_access,
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
        item_name: str,
        mime_type: str,
        size_bytes: int | None,
        file_name: str,
        purpose: str = PURPOSE_KNOWLEDGE,
        published: bool = True,
        created_by_user_id: UUID | None,
        description: str | None = None,
        language_code: str | None = None,
        owner_user_id: UUID | None = None,
        archive_item_id: UUID | None = None,
        archive_path: str | None = None,
        item_id: UUID | None = None,
        uploader_user_id: UUID | None = None,
        content_id: UUID | None = None,
    ) -> Item:
        """A DOCUMENT awaiting its bytes (``contentState`` PENDING, ``indexingState`` PENDING).

        Its ``item_type`` is the file class of the declared ``mime_type`` and
        ``file_name``; every revision must keep it. ``uploader_user_id`` opens
        the private upload ledger, which reserves the content identity
        (``content_id``, else a new one) and keeps the declared type, size and
        name; the bytes go to :func:`content_key` of it and
        :meth:`mark_upload_available` records revision 1. Without an uploader
        the caller appends the first revision itself. ``item_id`` makes
        creation idempotent (archive members): an existing row is returned
        unchanged.
        """
        identifier = item_id or uuid4()
        values = {
            "tenant_id": workspace_id,
            "item_kind": "document",
            "item_type": file_class(mime_type, file_name),
            "parent_item_id": parent.id,
            "item_name": item_name,
            "description": description,
            "purpose": purpose,
            "language_code": language_code,
            "owner_user_id": owner_user_id,
            "is_published": published,
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
                    content_id=content_id or new_content_id(),
                    mime_type=mime_type,
                    size_bytes=size_bytes,
                    file_name=file_name,
                    status="pending",
                    archive_item_id=archive_item_id,
                    archive_path=archive_path,
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
    ) -> Item:
        """The stored object validated: ``contentState`` AVAILABLE and revision 1.

        Revision 1 takes the content identity the upload reserved, so the
        object the client wrote is the revision's (nothing is copied). Nothing
        is processed here: a processable document waits ``pending`` for an
        Ingestion Run; anything else is kept ``unsupported``.
        """
        upload = await self._session.get(ItemUpload, item.id, with_for_update=True)
        if upload is None:
            raise InvalidDocumentStateError("the document has no upload")
        upload.status = "available"
        upload.error_code = None
        upload.uploaded_at = datetime.now(UTC)
        upload.size_bytes = size_bytes
        await self.set_index_state((item,), index_status="pending" if processable else "unsupported")
        if item.current_revision_id is None:
            revision = ItemRevision(
                item_id=item.id,
                revision_number=1,
                content_id=upload.content_id,
                mime_type=upload.mime_type,
                size_bytes=size_bytes,
                file_name=upload.file_name,
                created_by_user_id=upload.owner_user_id,
            )
            self._session.add(revision)
            await self._session.flush()
            item.current_revision = revision
            show_revision(item, revision)
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return item

    async def mark_upload_failed(self, item: Item, *, error_code: str) -> Item:
        """The stored object did not validate: ``contentState`` FAILED (the etag moves)."""
        upload = await self._session.get(ItemUpload, item.id, with_for_update=True)
        if upload is not None:
            upload.status = "failed"
            upload.error_code = error_code[:128]
        item.updated_at = func.now()
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        if item.current_revision_id is None:
            set_committed_value(item, "content_state", "failed")
        return item

    # -- Revisions ------------------------------------------------------------

    async def current_revision(self, item_id: UUID) -> ItemRevision | None:
        """The revision the Document shows (``items.current_revision_id``)."""
        return await self._session.scalar(
            select(ItemRevision)
            .join(Item, Item.current_revision_id == ItemRevision.id)
            .where(Item.id == item_id)
        )

    async def current_revision_numbers(self, item_ids: Iterable[UUID]) -> dict[UUID, int]:
        """The :meth:`current_revision` number of each item that has one, in one query."""
        ids = list(dict.fromkeys(item_ids))
        if not ids:
            return {}
        rows = await self._session.execute(
            select(Item.id, ItemRevision.revision_number)
            .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
            .where(Item.id.in_(ids))
        )
        return {item_id: int(number) for item_id, number in rows}

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
        content_id: UUID,
        mime_type: str,
        size_bytes: int,
        file_name: str | None = None,
        created_by_user_id: UUID | None = None,
        external_version: str | None = None,
        contribution_id: UUID | None = None,
        restored_from: int | None = None,
        summary: str | None = None,
        author: str | None = None,
        reuses: ItemRevision | None = None,
    ) -> ItemRevision:
        """Append revision n+1 and make it current (``item_model.md`` §4.8).

        ``content_id`` names the bytes (``bomesh.storage.keys``); a revision
        that shows existing bytes passes the revision it ``reuses``, whose
        ``content_id`` it must carry and whose derived exports (representation,
        cover, preview) it starts with, so nothing is copied or converted
        again. The document waits for an Ingestion Run (one that is never
        processed, such as an artifact, stays ``unsupported``). ``author`` is
        set for artifact revisions only. Content of another file class than
        the document's ``item_type`` raises
        :class:`~bomesh.services.knowledge_items.file_types.ItemTypeMismatchError`
        before anything is written.
        """
        if item.item_kind != "document":
            raise InvalidDocumentStateError("only documents have revisions")
        if reuses is not None and reuses.content_id != content_id:
            raise ValueError("a reused revision must carry the content it reuses")
        name = file_name or item.file_name or item.item_name
        require_file_class(item.item_type, mime_type, name)
        number = (
            await self._session.scalar(
                select(func.coalesce(func.max(ItemRevision.revision_number), 0)).where(
                    ItemRevision.item_id == item.id
                )
            )
            or 0
        ) + 1
        exports = (
            {key: reuses.exports[key] for key in _CONTENT_EXPORTS if key in reuses.exports}
            if reuses is not None
            else {}
        )
        revision = ItemRevision(
            item_id=item.id,
            revision_number=number,
            content_id=content_id,
            mime_type=mime_type,
            size_bytes=size_bytes,
            file_name=name,
            summary=summary,
            contribution_id=contribution_id,
            external_version=external_version,
            restored_from=restored_from,
            author=author,
            created_by_user_id=created_by_user_id,
            exports=exports,
        )
        self._session.add(revision)
        await self._session.flush()
        item.current_revision = revision
        show_revision(item, revision)
        if item.index_status != "unsupported":
            await self.set_index_state((item,), index_status="pending")
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
        item.current_revision = current
        show_revision(item, current)
        await self._session.flush()
        newest.deleted_at = await self._now()
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])
        return current

    async def record_revision_preview(
        self, item_id: UUID, revision_number: int, manifest: Mapping[str, Any]
    ) -> None:
        """Store a revision's viewer manifest (derived: the item's etag stays)."""
        revision = await self.revision(item_id, revision_number)
        if revision is None:
            return
        revision.exports = {**revision.exports, "preview": dict(manifest)}
        await self._session.flush()

    async def record_archive_expansion(self, item_id: UUID, summary: Mapping[str, Any]) -> None:
        """Store an archive's expansion summary on the revision it expanded (derived)."""
        item = await self._get_internal(item_id)
        if item.current_revision_id is None:
            return
        revision = await self._session.get(ItemRevision, item.current_revision_id)
        assert revision is not None
        revision.exports = {**revision.exports, "archive": dict(summary)}
        await self._session.flush()

    async def referenced_content_ids(
        self, content_ids: Iterable[UUID], *, purged_before: datetime
    ) -> frozenset[UUID]:
        """Contents still shown by a live revision of an Item not deleted before ``purged_before``."""
        wanted = list(dict.fromkeys(content_ids))
        if not wanted:
            return frozenset()
        return frozenset(
            await self._session.scalars(
                select(ItemRevision.content_id)
                .join(Item, Item.id == ItemRevision.item_id)
                .where(
                    ItemRevision.content_id.in_(wanted),
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
        """Stamp one ``deleted_at`` on the cohort, its shortcuts and citations; payloads dirty."""
        now = await self._now()
        ids = list(cohort.ids)
        await self._session.execute(
            update(Item)
            .where(Item.id.in_(ids))
            .values(deleted_at=now, updated_at=now)
        )
        await self.mark_payload_dirty(ids, now)
        await self._session.execute(
            update(ItemShortcut)
            .where(ItemShortcut.collection_item_id.in_(ids), ItemShortcut.deleted_at.is_(None))
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
        """Undo :meth:`delete_cohort` for exactly that cohort."""
        now = await self._now()
        ids = list(cohort.ids)
        await self._session.execute(
            update(Item).where(Item.id.in_(ids)).values(deleted_at=None, updated_at=now)
        )
        await self.mark_payload_dirty(ids, now)
        restorable = await self._session.scalars(
            select(ItemShortcut).where(
                ItemShortcut.collection_item_id.in_(ids), ItemShortcut.deleted_at == stamp
            )
        )
        for shortcut in restorable:
            if await self.live_shortcut(shortcut.collection_item_id, shortcut.target_item_id) is None:
                shortcut.deleted_at = None
                shortcut.updated_at = now
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
        owner's personal collection becomes PUBLISHED there; a live shortcut of
        the destination to the item is deleted in the same transaction.
        """
        now = await self._now()
        item.parent_item_id = destination.id if destination is not None else None
        if destination is None:
            item.inherit_access = False
        if item.item_kind == "document" and destination is not None and is_personal(destination):
            item.is_published = True
        if destination is not None:
            shortcut = await self.live_shortcut(destination.id, item.id)
            if shortcut is not None:
                shortcut.deleted_at = now
                shortcut.updated_at = now
        moved: tuple[UUID, ...] = ()
        if item.item_kind == "document":
            tree = descendants(item.id)
            moved = tuple(
                await self._session.scalars(
                    select(Item.id).where(
                        Item.id.in_(select(tree.c.id)), Item.item_kind == "document"
                    )
                )
            )
            await self.mark_payload_dirty(moved, now)
        await self._session.flush()
        await self._session.refresh(item)
        return moved

    async def set_publication(self, item: Item, *, published: bool) -> None:
        item.is_published = published
        await self.mark_payload_dirty((item.id,), await self._now())
        await self._session.flush()
        await self._session.refresh(item, attribute_names=["updated_at"])

    async def live_shortcut(self, collection_id: UUID, target_id: UUID) -> ItemShortcut | None:
        return await self._session.scalar(
            select(ItemShortcut).where(
                ItemShortcut.collection_item_id == collection_id,
                ItemShortcut.target_item_id == target_id,
                ItemShortcut.deleted_at.is_(None),
            )
        )

    # -- Engine maintenance ---------------------------------------------------

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
        return await self._set_index_status(
            item_id,
            "ready",
            processed_version=processed_version,
            indexed_revision_number=indexed_revision_number,
        )

    async def set_index_state(self, items: Sequence[Item], **values: str | int | None) -> None:
        """Write the documents' :class:`ItemIndexState` (never their ``items`` row, so
        neither ``updated_at`` nor the etag moves) and keep their loaded views current."""
        assert values.keys() <= _INDEX_VIEWS, values.keys() - _INDEX_VIEWS
        if not items:
            return
        await self._session.execute(
            update(ItemIndexState)
            .where(ItemIndexState.item_id.in_([item.id for item in items]))
            .values(**values)
        )
        for item in items:
            for key, value in values.items():
                set_committed_value(item, key, value)

    async def mark_payload_dirty(self, item_ids: Iterable[UUID], at: Any) -> None:
        """The Qdrant payload of these documents must be re-applied (collections are skipped)."""
        await self._session.execute(
            update(ItemIndexState)
            .where(ItemIndexState.item_id.in_(list(item_ids)))
            .values(payload_dirty_at=at)
        )

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

    async def _set_index_status(
        self, item_id: UUID, status: str, **values: str | int | None
    ) -> Item:
        if status not in INDEX_STATUSES:
            raise ValueError(f"unsupported index status: {status}")
        item = await self._get_internal(item_id)
        if item.deleted_at is not None:
            raise InvalidDocumentStateError("cannot update a deleted item")
        if item.item_kind != "document":
            raise InvalidDocumentStateError("only documents have an index lifecycle")
        await self.set_index_state((item,), index_status=status, **values)
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


async def ensure_personal_collection(
    session: AsyncSession, workspace_id: UUID, user_id: UUID
) -> UUID:
    """Create the member's PERSONAL collection if missing; returns its ID (idempotent)."""
    return await ItemService(session).ensure_personal_collection(workspace_id, user_id)


__all__ = [
    "COLLECTION_OWNER_ROLE",
    "HIDDEN_TYPES",
    "PERSONAL_NAME",
    "PURPOSE_ATTACHMENT",
    "PURPOSE_KNOWLEDGE",
    "STANDARD_COLLECTION_TYPE",
    "Cohort",
    "ItemService",
    "artifact_collection_id",
    "catalog_visibility",
    "collection_subtree",
    "descendants",
    "ensure_personal_collection",
    "has_open_contribution",
    "hidden_collections",
    "in_subtree",
    "is_hidden",
    "is_knowledge_format",
    "is_personal",
    "is_source_candidate",
    "is_source_managed",
    "item_content_key",
    "personal_collection_id",
    "purpose",
    "visible_item_ids",
]
