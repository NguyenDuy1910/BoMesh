"""Items: create, upload, read, list, update and the lifecycle custom methods.

``item_model.md`` §4 and §7 decide every rule here; the engine
(:mod:`bomesh.services.knowledge_items.item_store`) changes rows, this service authorizes,
validates, audits and re-applies index payloads after commit.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, false, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemRevision, Tenant
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
    Unavailable,
)
from bomesh.iam.authorizer import (
    ItemRef,
    Principal,
    WorkspaceRef,
    not_found,
    permission_denied,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import require_restorable
from bomesh.services.kernel.workspaces import workspace_name
from bomesh.services.knowledge_items.documents import (
    tag_document,
    validated_document_type,
)
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_KINDS,
    PURPOSE_ATTACHMENT,
    PURPOSE_KNOWLEDGE,
    Cohort,
    ItemService,
    catalog_visibility,
    document_type_for_content_type,
    is_archive,
    is_image,
    is_knowledge_format,
    is_personal,
    is_source_candidate,
    is_source_managed,
    purpose,
)
from bomesh.services.knowledge_items.names import (
    item_name,
    parse_item,
)
from bomesh.services.knowledge_items.records import (
    ItemPage,
    ItemRecord,
    NewDocument,
    NewItem,
    RevisionRecord,
    UploadedFile,
)
from bomesh.services.knowledge_items.spaces import space_id_of
from bomesh.services.knowledge_items.support import (
    EDIT,
    KnowledgeDeps,
    Projector,
    boundary_of,
    check_etag,
    governing_collection,
    is_hidden_item,
    load_content_source,
    load_item,
    load_referenced,
    require_document,
    require_no_open_contribution,
)
from bomesh.storage import ObjectNotFoundError, ObjectStorageError

MAX_DISPLAY_NAME = 512

#: UpdateItem paths and the permission each needs besides ``items.update``.
COLLECTION_PATHS = frozenset(
    {
        "collection.description",
        "collection.discoverable",
        "collection.acceptsContributions",
        "collection.space",
        "collection.inheritAccess",
    }
)
DOCUMENT_PATHS = frozenset(
    {
        "document.documentType",
        "document.topics",
        "document.summary",
        "document.languageCode",
        "document.owner",
    }
)


class KnowledgeItemService:
    """The Item resource: one canonical service for collections and documents."""

    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> KnowledgeItemService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    # -- Create ---------------------------------------------------------------

    async def create(
        self, ctx: RequestContext, workspace_id: UUID, spec: NewItem, *, request_id: UUID | None
    ) -> ItemRecord:
        """CreateItem: a collection, or a document awaiting its bytes at ``uploadUri``."""
        item_id = await self._create(
            ctx, workspace_id, spec, request_id=request_id, method="CreateItem", digest=None
        )
        return await self.get(ctx, workspace_id, item_id)

    async def create_media(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewItem,
        file: UploadedFile,
        *,
        request_id: UUID | None,
        published: bool = True,
    ) -> ItemRecord:
        """CreateItemMedia: the same creation, with the bytes stored and validated at once."""
        if spec.item_type != "document" or spec.document is None:
            raise InvalidArgument.for_field(
                "metadata.itemType", "A media upload creates a DOCUMENT."
            )
        if not file.data:
            raise InvalidArgument.for_field("file", "The file is empty.")
        if len(file.data) > self._deps.max_upload_bytes:
            raise InvalidArgument(
                f"The file exceeds the {self._deps.max_upload_bytes} byte upload limit.",
                reason="FILE_TOO_LARGE",
            )
        size = spec.document.size_bytes
        if size is not None and size != len(file.data):
            raise InvalidArgument.for_field(
                "metadata.document.sizeBytes", "sizeBytes does not match the file."
            )
        document = spec.document
        spec = NewItem(
            item_type=spec.item_type,
            display_name=spec.display_name,
            parent_id=spec.parent_id,
            document=type(document)(
                mime_type=document.mime_type or file.content_type,
                file_name=document.file_name or file.file_name,
                size_bytes=len(file.data),
                purpose=document.purpose,
                document_type=document.document_type,
                summary=document.summary,
                language_code=document.language_code,
                owner_id=document.owner_id,
                topics=document.topics,
            ),
        )
        item_id = await self._create(
            ctx,
            workspace_id,
            spec,
            request_id=request_id,
            method="CreateItemMedia",
            digest=hashlib.sha256(file.data).hexdigest(),
            published=published,
        )
        async with transaction_scope(self._deps.sessions) as session:
            item = await session.get(Item, item_id)
            assert item is not None and item.storage_key is not None
            pending = item.status != "ready"
            key, mime_type = item.storage_key, item.mime_type or "application/octet-stream"
        if pending:
            try:
                stored = await asyncio.to_thread(
                    self._deps.storage.put_bytes, file.data, key, content_type=mime_type
                )
            except ObjectStorageError as error:
                # The document must not stay PENDING forever: it reads FAILED, and
                # a retry with the same requestId stores the bytes again.
                async with transaction_scope(self._deps.sessions) as session:
                    item = await session.get(Item, item_id, with_for_update=True)
                    assert item is not None
                    await ItemService(session).mark_upload_failed(
                        item, error_code="storage_unavailable"
                    )
                raise Unavailable("Document storage is temporarily unavailable.") from error
            async with transaction_scope(self._deps.sessions) as session:
                item = await session.get(Item, item_id, with_for_update=True)
                assert item is not None
                await ItemService(session).mark_upload_available(
                    item,
                    size_bytes=stored.size_bytes,
                    processable=_processable(item),
                    storage_metadata={"etag": stored.etag, "version_id": stored.version_id},
                )
        return await self.get(ctx, workspace_id, item_id)

    async def _create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewItem,
        *,
        request_id: UUID | None,
        method: str,
        digest: str | None,
        published: bool = True,
    ) -> UUID:
        gate = ItemRef(workspace_id, spec.parent_id) if spec.parent_id else WorkspaceRef(workspace_id)
        await self._deps.workspaces.open(ctx, gate, "items.create", write=True)
        _validate_display_name(spec.display_name)
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method=method,
                    parent=workspace_name(workspace_id),
                    request={**spec.fingerprint(), "file": digest},
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    return parse_item(replayed, workspace_id, field="requestId")
            parent = (
                await load_referenced(
                    session, ctx, workspace_id, spec.parent_id, permission="items.create"
                )
                if spec.parent_id is not None
                else None
            )
            if parent is not None and parent.item_type != "collection":
                raise InvalidArgument.for_field(
                    "parentItem", "parentItem must be a COLLECTION."
                )
            if spec.item_type == "collection":
                item = await self._create_collection(session, ctx, workspace_id, spec, parent)
            else:
                if parent is None:
                    raise InvalidArgument.for_field(
                        "parentItem", "A DOCUMENT needs a parentItem."
                    )
                item = await self._create_document(
                    session, ctx, workspace_id, spec, parent, published=published
                )
            name = item_name(workspace_id, item.id)
            await Audit(session).record(
                ctx, workspace_id=workspace_id, category="knowledge", action=method, target=name
            )
            if key is not None:
                await idempotency.remember(key, name)
            return item.id

    async def _create_collection(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewItem,
        parent: Item | None,
    ) -> Item:
        if spec.document is not None:
            raise InvalidArgument.for_field("document", "A COLLECTION has no document facet.")
        facet = spec.collection
        metadata: dict[str, Any] = {}
        if facet is not None:
            if facet.description:
                metadata["description"] = facet.description
            if facet.discoverable is not None:
                metadata["discoverable"] = facet.discoverable
            if facet.accepts_contributions is not None:
                metadata["accepts_contributions"] = facet.accepts_contributions
        if parent is None and facet is not None and facet.inherit_access:
            raise InvalidArgument.for_field(
                "collection.inheritAccess", "A root collection is always an access boundary."
            )
        space_id = (
            await space_id_of(session, workspace_id, facet.space)
            if facet is not None and facet.space
            else None
        )
        items = ItemService(session)
        item = await items.create_collection(
            workspace_id=workspace_id,
            title=spec.display_name,
            created_by_user_id=ctx.user_id,
            parent_item_id=parent.id if parent is not None else None,
            inherit_access=True if facet is None or facet.inherit_access is None else facet.inherit_access,
            metadata=metadata,
            space_id=space_id,
        )
        if parent is None:
            await items.grant_owner(item.id, ctx.user_id)
        return item

    async def _create_document(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewItem,
        parent: Item,
        *,
        published: bool,
    ) -> Item:
        if spec.collection is not None:
            raise InvalidArgument.for_field("collection", "A DOCUMENT has no collection facet.")
        facet = spec.document
        if facet is None or not facet.mime_type:
            raise InvalidArgument.for_field("document.mimeType", "document.mimeType is required.")
        if facet.size_bytes is None:
            raise InvalidArgument.for_field(
                "document.sizeBytes", "document.sizeBytes is required for a signed upload."
            )
        if facet.size_bytes < 1:
            raise InvalidArgument.for_field("document.sizeBytes", "The file is empty.")
        if facet.size_bytes > self._deps.max_upload_bytes:
            raise InvalidArgument(
                f"The file exceeds the {self._deps.max_upload_bytes} byte upload limit.",
                reason="FILE_TOO_LARGE",
            )
        mime_type = facet.mime_type.split(";", 1)[0].strip().casefold()
        file_name = (facet.file_name or spec.display_name).strip()
        _check_format(
            ctx, workspace_id, parent, file_name=file_name, mime_type=mime_type, purpose=facet.purpose
        )
        metadata: dict[str, Any] = {}
        if facet.summary:
            metadata["summary"] = facet.summary
        if facet.language_code:
            metadata["language"] = facet.language_code
        if facet.owner_id is not None:
            await _require_member(ctx, workspace_id, facet.owner_id, field="document.owner")
            metadata["owner_user_id"] = str(facet.owner_id)
        item = await ItemService(session).create_document(
            workspace_id=workspace_id,
            parent=parent,
            title=spec.display_name,
            document_type=validated_document_type(facet.document_type)
            if facet.document_type
            else document_type_for_content_type(mime_type),
            mime_type=mime_type,
            size_bytes=facet.size_bytes,
            file_name=file_name,
            purpose=facet.purpose,
            published=published,
            created_by_user_id=ctx.user_id,
            uploader_user_id=ctx.user_id,
            metadata=metadata,
        )
        if facet.topics:
            await tag_document(
                session, workspace_id, item.id, facet.topics, created_by_user_id=ctx.user_id
            )
        return item

    async def complete_upload(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        """CompleteItemUpload: validate the stored object and record revision 1."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.create", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(session, ctx, workspace_id, item_id, permission="items.create")
            if item.item_type != "document":
                raise FailedPrecondition("A COLLECTION has no content to upload.")
            if item.created_by_user_id != ctx.user_id:
                raise permission_denied("items.create", ItemRef(workspace_id, item_id))
            check_etag(item, etag)
            if item.status == "ready":
                return await self._record(session, ctx, workspace_id, item)
            await require_no_open_contribution(session, item)
            key, expected_size, expected_type = item.storage_key, item.size_bytes, item.mime_type
        assert key is not None
        try:
            stored = await self._deps.storage.head(key)
        except ObjectNotFoundError:
            raise FailedPrecondition(
                "The file has not been uploaded yet.", reason="UPLOAD_INCOMPLETE"
            ) from None
        valid = stored.size_bytes == expected_size and (
            stored.content_type is None
            or stored.content_type.split(";", 1)[0].strip().casefold() == expected_type
        )
        async with transaction_scope(self._deps.sessions) as session:
            item = await session.get(Item, item_id, with_for_update=True, populate_existing=True)
            assert item is not None
            items = ItemService(session)
            if item.status != "ready":
                if valid:
                    await items.mark_upload_available(
                        item,
                        size_bytes=stored.size_bytes,
                        processable=_processable(item),
                        storage_metadata={"etag": stored.etag, "version_id": stored.version_id},
                    )
                else:
                    await items.mark_upload_failed(item, error_code="OBJECT_INVALID")
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="knowledge",
                    action="CompleteItemUpload",
                    target=item_name(workspace_id, item_id),
                    outcome="succeeded" if valid else "failed",
                )
            return await self._record(session, ctx, workspace_id, item)

    # -- Read -----------------------------------------------------------------

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, full: bool = True
    ) -> ItemRecord:
        """GetItem: the visible item, a DELETED one for restorers, or a LOCKED root."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            try:
                item = await load_item(
                    session,
                    ctx,
                    workspace_id,
                    item_id,
                    include_deleted=True,
                    reviewer_exception=True,
                )
            except (NotFound, PermissionDenied) as error:
                locked = await _discoverable_root(session, ctx, workspace_id, item_id)
                if locked is None:
                    raise error from None
                projector = await Projector.open(session, ctx, workspace_id, self._deps)
                return await projector.locked(locked)
            return await self._record(session, ctx, workspace_id, item, full=full)

    async def media_url(self, ctx: RequestContext, workspace_id: UUID, item_id: UUID) -> str:
        """GetItem ``alt=media``: a short-lived signed URL of the current revision's original."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(
                session, ctx, workspace_id, item_id, reviewer_exception=True
            )
        if item.item_type != "document":
            raise InvalidArgument.for_field("alt", "alt=media applies to DOCUMENT items only.")
        if item.status != "ready" or item.storage_key is None:
            raise FailedPrecondition("The document has no stored content yet.")
        return self._deps.storage.presign_download(
            item.storage_key, expires_seconds=self._deps.download_url_seconds
        ).url

    async def list(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        query: ListQuery,
        *,
        full: bool = False,
        show_locked: bool = False,
        referenced: frozenset[UUID] = frozenset(),
    ) -> ItemPage:
        """ListItems: visible items (DELETED ones for restorers), LOCKED roots last."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "items.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            for referenced_id in referenced:
                await load_referenced(
                    session, ctx, workspace_id, referenced_id, permission="items.get"
                )
            visibility = await catalog_visibility(
                session,
                ctx.authorizer,
                ctx.principal,
                workspace_id,
                show_deleted=query.show_deleted,
            )
            visible = visibility.clause()
            locked = (
                _locked_roots(workspace_id, visibility.readable) if show_locked else false()
            )
            scope = and_(query.where, or_(visible, locked))
            is_locked = case((visible, 1), else_=0)
            statement = (
                select(Item)
                .where(scope)
                .order_by(
                    is_locked.desc(),
                    case((visible, literal("")), else_=Item.title),
                    *query.order_by,
                )
                .offset(query.offset)
                .limit(query.limit)
            )
            rows = list(await session.scalars(statement))
            total = await session.scalar(select(func.count()).select_from(select(Item.id).where(scope).subquery()))
            readable_ids = set(
                await session.scalars(
                    select(Item.id).where(Item.id.in_([row.id for row in rows]), visible)
                )
            )
            projector = await Projector.open(session, ctx, workspace_id, self._deps)
            records = [
                await projector.project(row, full=full)
                if row.id in readable_ids
                else await projector.locked(row)
                for row in rows
            ]
        return ItemPage(items=records, total_size=int(total or 0))

    # -- Update ---------------------------------------------------------------

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        changes: Mapping[str, Any],
        *,
        etag: str | None,
    ) -> ItemRecord:
        """UpdateItem: metadata only, no side effects."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), EDIT, write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission=EDIT, for_update=True
            )
            check_etag(item, etag)
            facet_paths = COLLECTION_PATHS if item.item_type == "collection" else DOCUMENT_PATHS
            for path in changes:
                if path != "displayName" and path not in facet_paths:
                    raise InvalidArgument.for_field(
                        "updateMask", f"{path} does not apply to a {item.item_type.upper()}."
                    )
            metadata = dict(item.metadata_)
            for path, value in changes.items():
                await self._apply_change(session, ctx, workspace_id, item, metadata, path, value)
            item.metadata_ = metadata
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="UpdateItem",
                target=item_name(workspace_id, item_id),
                details={"updateMask": ",".join(changes)},
            )
            await session.refresh(item)
            return await self._record(session, ctx, workspace_id, item)

    async def _apply_change(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        item: Item,
        metadata: dict[str, Any],
        path: str,
        value: Any,
    ) -> None:
        match path:
            case "displayName":
                _validate_display_name(value or "")
                item.title = value
            case "collection.description" | "document.summary":
                _set_text(metadata, "description" if path.startswith("collection") else "summary", value)
            case "document.languageCode":
                _set_text(metadata, "language", value)
            case "collection.discoverable":
                if value and item.parent_item_id is not None:
                    raise InvalidArgument.for_field(
                        "collection.discoverable", "Only root collections are discoverable."
                    )
                _set_flag(metadata, "discoverable", value)
            case "collection.acceptsContributions":
                _set_flag(metadata, "accepts_contributions", value)
            case "collection.space":
                item.space_id = await space_id_of(session, workspace_id, value) if value else None
            case "collection.inheritAccess":
                await ctx.authorizer.require(
                    ctx.principal, "items.setIamPolicy", ItemRef(workspace_id, item.id)
                )
                if item.parent_item_id is None and value:
                    raise InvalidArgument.for_field(
                        "collection.inheritAccess",
                        "A root collection is always an access boundary.",
                    )
                if is_personal(item):
                    raise FailedPrecondition(
                        "A PERSONAL collection cannot be shared.", reason="PERSONAL_COLLECTION"
                    )
                item.inherit_access = bool(value) and item.parent_item_id is not None
            case "document.documentType":
                item.document_type = validated_document_type(value or "")
            case "document.topics":
                await tag_document(
                    session, workspace_id, item.id, tuple(value or ()), created_by_user_id=ctx.user_id
                )
            case "document.owner":
                if value is None:
                    metadata.pop("owner_user_id", None)
                    return
                await _require_member(ctx, workspace_id, value, field="document.owner")
                metadata["owner_user_id"] = str(value)

    # -- Delete and undelete ----------------------------------------------------

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        *,
        force: bool,
        etag: str | None,
    ) -> ItemRecord:
        """DeleteItem: tombstone the live subtree as one cohort (``force`` when not empty)."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.delete", for_update=True
            )
            check_etag(item, etag)
            if is_personal(item):
                raise FailedPrecondition(
                    "A PERSONAL collection cannot be deleted.", reason="PERSONAL_COLLECTION"
                )
            items = ItemService(session)
            if item.item_type == "collection" and not force and await items.has_live_children(item.id):
                raise FailedPrecondition(
                    "The collection is not empty; delete it with force.",
                    reason="COLLECTION_NOT_EMPTY",
                )
            cohort = await items.live_subtree(item)
            for member in cohort.items:
                await require_no_open_contribution(session, member)
            await _require_on_boundaries(ctx, workspace_id, cohort, item, "items.delete")
            await items.delete_cohort(cohort)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="DeleteItem",
                target=item_name(workspace_id, item_id),
                details={"cohortSize": len(cohort.items)},
            )
            dirty = cohort.document_ids
        await self._deps.payloads.sync_payloads(dirty)
        return await self._reload(ctx, workspace_id, item_id)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        """UndeleteItem: restore exactly the cohort deleted with the item."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.undelete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session,
                ctx,
                workspace_id,
                item_id,
                permission="items.undelete",
                include_deleted=True,
                for_update=True,
            )
            if item.deleted_at is None:
                raise AlreadyExists("The item is not deleted.")
            require_restorable(item.deleted_at, item_name(workspace_id, item_id))
            check_etag(item, etag)
            if item.parent_item_id is not None:
                parent = await session.get(Item, item.parent_item_id)
                if parent is not None and parent.deleted_at is not None:
                    raise FailedPrecondition(
                        "The parent is deleted; restore it first.", reason="PARENT_DELETED"
                    )
            items = ItemService(session)
            stamp = item.deleted_at
            cohort = await items.deleted_cohort(item)
            await _require_on_boundaries(
                ctx, workspace_id, cohort, item, "items.undelete", include_deleted=True
            )
            await items.restore_cohort(cohort, stamp)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="UndeleteItem",
                target=item_name(workspace_id, item_id),
                details={"cohortSize": len(cohort.items)},
            )
            dirty = cohort.document_ids
        await self._deps.payloads.sync_payloads(dirty)
        return await self._reload(ctx, workspace_id, item_id)

    # -- Move, publish, verify, merge -----------------------------------------

    async def move(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        destination_id: UUID | None,
        *,
        etag: str | None,
    ) -> ItemRecord:
        """MoveItem: reparent under a collection (or make a collection a root)."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.move", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.move", for_update=True
            )
            check_etag(item, etag)
            await _check_movable(session, item)
            destination = await self._destination(session, ctx, workspace_id, item, destination_id)
            await self._require_boundary_rule(ctx, workspace_id, item, destination)
            dirty = await ItemService(session).move(item, destination)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="MoveItem",
                target=item_name(workspace_id, item_id),
                details={
                    "destinationParent": item_name(workspace_id, destination.id)
                    if destination is not None
                    else workspace_name(workspace_id)
                },
            )
        await self._deps.payloads.sync_payloads(dirty)
        return await self._reload(ctx, workspace_id, item_id)

    async def _destination(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        item: Item,
        destination_id: UUID | None,
    ) -> Item | None:
        if destination_id is None:
            if item.item_type != "collection":
                raise InvalidArgument.for_field(
                    "destinationParent", "A DOCUMENT cannot become a root."
                )
            await ctx.authorizer.require(ctx.principal, "items.create", WorkspaceRef(workspace_id))
            return None
        if destination_id == item.id or any(
            node.item_id == item.id for node in await ctx.authorizer.ancestry(destination_id)
        ):
            raise InvalidArgument(
                "An item cannot move into itself or a descendant.",
                reason="MOVE_INTO_DESCENDANT",
            )
        destination = await load_referenced(
            session, ctx, workspace_id, destination_id, permission="items.get"
        )
        if destination.item_type != "collection":
            raise InvalidArgument.for_field(
                "destinationParent", "destinationParent must be a COLLECTION."
            )
        if is_personal(destination):
            if destination.created_by_user_id != ctx.user_id:
                raise permission_denied("items.create", ItemRef(workspace_id, destination.id))
            if item.item_type != "document":
                raise InvalidArgument.for_field(
                    "destinationParent", "Only documents move into a PERSONAL collection."
                )
        await ctx.authorizer.require(
            ctx.principal, "items.create", ItemRef(workspace_id, destination.id)
        )
        return destination

    async def _require_boundary_rule(
        self, ctx: RequestContext, workspace_id: UUID, item: Item, destination: Item | None
    ) -> None:
        """Changing the governing boundary also needs ``items.setIamPolicy`` on the source one."""
        if not item.inherit_access:
            return
        source = await boundary_of(ctx, item.parent_item_id) if item.parent_item_id else None
        target = await boundary_of(ctx, destination.id) if destination is not None else item.id
        if source is not None and source != target:
            await ctx.authorizer.require(
                ctx.principal, "items.setIamPolicy", ItemRef(workspace_id, source)
            )

    async def publish(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        return await self._set_publication(ctx, workspace_id, item_id, etag=etag, published=True)

    async def unpublish(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        return await self._set_publication(ctx, workspace_id, item_id, etag=etag, published=False)

    async def _set_publication(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        *,
        etag: str | None,
        published: bool,
    ) -> ItemRecord:
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.publish", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.publish", for_update=True
            )
            check_etag(item, etag)
            await _check_publishable(session, item, published=published)
            await ItemService(session).set_publication(item, published=published)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="PublishItem" if published else "UnpublishItem",
                target=item_name(workspace_id, item_id),
            )
        await self._deps.payloads.sync_payloads((item_id,))
        return await self._reload(ctx, workspace_id, item_id)

    async def verify(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        """VerifyItem: VERIFIED by the caller, due again after the workspace's interval."""
        workspace = await self._deps.workspaces.open(
            ctx, ItemRef(workspace_id, item_id), "items.verify", write=True
        )
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.verify", for_update=True
            )
            check_etag(item, etag)
            require_document(item, error=FailedPrecondition)
            if item.publication_state != "published":
                raise FailedPrecondition("Only a PUBLISHED document can be verified.")
            now = await session.scalar(select(func.now()))
            assert now is not None
            record: dict[str, Any] = {
                "state": "verified",
                "verifier_user_id": str(ctx.user_id),
                "verified_at": now.isoformat(),
            }
            interval = _reverification_interval(workspace)
            if interval is not None:
                record["next_review_at"] = (now + interval).isoformat()
            item.metadata_ = {**item.metadata_, "verification": record}
            await session.flush()
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="VerifyItem",
                target=item_name(workspace_id, item_id),
            )
            await session.refresh(item)
            return await self._record(session, ctx, workspace_id, item)

    async def merge(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        target_id: UUID,
        *,
        etag: str | None,
    ) -> ItemRecord:
        """MergeItem: delete this duplicate, recording ``mergedInto``; nothing moves."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.delete", for_update=True
            )
            require_document(item, error=FailedPrecondition)
            target = await load_referenced(
                session, ctx, workspace_id, target_id, permission=EDIT, include_deleted=True
            )
            if target.id == item.id or target.item_type != "document" or target.deleted_at is not None:
                raise FailedPrecondition(
                    "targetItem must be another live DOCUMENT."
                )
            await require_no_open_contribution(session, item)
            check_etag(item, etag)
            items = ItemService(session)
            cohort = await items.live_subtree(item)
            item.metadata_ = {**item.metadata_, "merged_into": str(target.id)}
            await session.flush()
            await items.delete_cohort(cohort)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="MergeItem",
                target=item_name(workspace_id, item_id),
                details={"targetItem": item_name(workspace_id, target.id)},
            )
            dirty = cohort.document_ids
        await self._deps.payloads.sync_payloads(dirty)
        return await self._reload(ctx, workspace_id, item_id)

    # -- Revisions ------------------------------------------------------------

    async def list_revisions(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, offset: int, limit: int
    ) -> list[RevisionRecord]:
        """ListItemRevisions: newest first."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(session, ctx, workspace_id, item_id)
            require_document(item)
            rows = await session.scalars(
                select(ItemRevision)
                .where(ItemRevision.item_id == item_id, ItemRevision.deleted_at.is_(None))
                .order_by(ItemRevision.revision_number.desc())
                .offset(offset)
                .limit(limit)
            )
            return [_revision_record(workspace_id, row) for row in rows]

    async def get_revision(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, number: int
    ) -> RevisionRecord:
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(session, ctx, workspace_id, item_id)
            require_document(item)
            revision = await ItemService(session).revision(item_id, number)
            if revision is None:
                raise NotFound(f"Revision {number} of '{item_name(workspace_id, item_id)}' was not found.")
            return _revision_record(workspace_id, revision)

    async def rollback(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        number: int,
        *,
        etag: str | None,
    ) -> ItemRecord:
        """RollbackItem: append a revision that reuses an older revision's object."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.publish", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.publish", for_update=True
            )
            require_document(item)
            items = ItemService(session)
            revision = await items.revision(item_id, number)
            if revision is None:
                raise NotFound(f"Revision {number} of '{item_name(workspace_id, item_id)}' was not found.")
            if is_source_managed(item):
                raise FailedPrecondition(
                    "The source is the truth for this document.", reason="SOURCE_MANAGED"
                )
            await require_no_open_contribution(session, item)
            check_etag(item, etag)
            current = await items.current_revision(item_id)
            if current is not None and current.revision_number == number:
                raise FailedPrecondition("That revision is already the current one.")
            await items.append_revision(
                item,
                storage_key=revision.storage_key,
                mime_type=revision.mime_type,
                size_bytes=revision.size_bytes,
                file_name=revision.exports.get("file_name"),
                created_by_user_id=ctx.user_id,
                restored_from=number,
            )
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="knowledge",
                action="RollbackItem",
                target=item_name(workspace_id, item_id),
                details={"restoredFrom": number},
            )
            return await self._record(session, ctx, workspace_id, item)

    # -- Internals ------------------------------------------------------------

    async def _record(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        item: Item,
        *,
        full: bool = False,
    ) -> ItemRecord:
        projector = await Projector.open(session, ctx, workspace_id, self._deps)
        return await projector.project(item, full=full)

    async def _reload(self, ctx: RequestContext, workspace_id: UUID, item_id: UUID) -> ItemRecord:
        """The item after a write the caller was authorized for."""
        async with transaction_scope(self._deps.sessions) as session:
            item = await session.get(Item, item_id)
            assert item is not None
            return await self._record(session, ctx, workspace_id, item)


# -- Cross-slice operations ---------------------------------------------------


async def create_document(
    items: KnowledgeItemService,
    ctx: RequestContext,
    workspace_id: UUID,
    parent_id: UUID,
    file: UploadedFile,
    *,
    display_name: str,
    purpose: str = PURPOSE_KNOWLEDGE,
    published: bool = True,
    request_id: UUID | None = None,
) -> ItemRecord:
    """A new DOCUMENT holding ``file`` under ``parent_id``, as the caller (``items.create``).

    The CreateItemMedia pipeline: same format rules, the bytes stored and the
    document AVAILABLE with revision 1; nothing is processed.
    """
    spec = NewItem(
        item_type="document",
        display_name=display_name,
        parent_id=parent_id,
        document=NewDocument(
            mime_type=file.content_type,
            file_name=file.file_name or display_name,
            purpose=purpose,
        ),
    )
    return await items.create_media(
        ctx, workspace_id, spec, file, request_id=request_id, published=published
    )


# Contribution approval: the caller authorizes; these run in its session.


async def move_item(
    session: AsyncSession, workspace_id: UUID, item_id: UUID, destination_id: UUID
) -> tuple[UUID, ...]:
    """Move a document under a collection (contribution approval); returns dirty payloads.

    Apply them after commit with :func:`sync_item_payloads` (the scheduled
    reconciliation also converges them).
    """
    item = await _row(session, workspace_id, item_id, for_update=True)
    destination = await _row(session, workspace_id, destination_id)
    if destination.item_type != "collection" or destination.deleted_at is not None:
        raise InvalidArgument("The destination must be a live COLLECTION.")
    return await ItemService(session).move(item, destination)


async def publish_item(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> tuple[UUID, ...]:
    """Publish a document (contribution approval); returns dirty payloads."""
    item = await _row(session, workspace_id, item_id, for_update=True)
    require_document(item, error=FailedPrecondition)
    if item.publication_state != "published":
        await ItemService(session).set_publication(item, published=True)
    return (item.id,)


async def append_revision_from(
    session: AsyncSession,
    candidate_id: UUID,
    target_id: UUID,
    contribution_id: UUID | None,
    *,
    created_by_user_id: UUID | None = None,
    summary: str | None = None,
) -> int:
    """Append the candidate's current content to ``target`` as its newest revision.

    The candidate's object is reused (never copied); returns the new revision
    number. The caller deletes the candidate (:func:`delete_item`).
    """
    candidate = await session.get(Item, candidate_id)
    target = await session.get(Item, target_id, with_for_update=True)
    if candidate is None or target is None or candidate.tenant_id != target.tenant_id:
        raise NotFound("The candidate or the replaced document does not exist.")
    require_document(candidate, error=FailedPrecondition)
    require_document(target, error=FailedPrecondition)
    if candidate.storage_key is None or candidate.status != "ready":
        raise FailedPrecondition("The candidate has no available content.")
    revision = await ItemService(session).append_revision(
        target,
        storage_key=candidate.storage_key,
        mime_type=candidate.mime_type or "application/octet-stream",
        size_bytes=candidate.size_bytes or 0,
        file_name=candidate.metadata_.get("file_name"),
        created_by_user_id=created_by_user_id,
        contribution_id=contribution_id,
        summary=summary,
    )
    return revision.revision_number


async def delete_item(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> tuple[UUID, ...]:
    """Delete an item and its live subtree as one cohort; returns dirty payloads."""
    item = await _row(session, workspace_id, item_id, for_update=True)
    items = ItemService(session)
    cohort = await items.live_subtree(item)
    await items.delete_cohort(cohort)
    return cohort.document_ids


async def _row(session: AsyncSession, workspace_id: UUID, item_id: UUID, *, for_update: bool = False) -> Item:
    item = await session.get(Item, item_id, with_for_update=for_update)
    if item is None or item.tenant_id != workspace_id:
        raise not_found(ItemRef(workspace_id, item_id))
    return item


# -- Rules --------------------------------------------------------------------


def _validate_display_name(value: str) -> None:
    if not value.strip():
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    if len(value) > MAX_DISPLAY_NAME:
        raise InvalidArgument.for_field(
            "displayName", f"displayName is at most {MAX_DISPLAY_NAME} characters."
        )


def _check_format(
    ctx: RequestContext,
    workspace_id: UUID,
    parent: Item,
    *,
    file_name: str,
    mime_type: str,
    purpose: str,
) -> None:
    """Images only as attachments, attachments only in one's own personal
    collection, archives only into STANDARD collections (``FORMAT_NOT_ALLOWED``)."""
    own_personal = is_personal(parent) and parent.created_by_user_id == ctx.user_id
    allowed = True
    if purpose == PURPOSE_ATTACHMENT:
        allowed = own_personal and not is_archive(file_name, mime_type)
    elif is_image(file_name, mime_type):
        allowed = False
    elif is_archive(file_name, mime_type):
        allowed = not is_personal(parent)
    if not allowed:
        raise InvalidArgument(
            "This file format is not allowed here.", reason="FORMAT_NOT_ALLOWED"
        )


def _processable(item: Item) -> bool:
    """Knowledge formats and archives wait for a run; anything else stays UNSUPPORTED."""
    file_name = str(item.metadata_.get("file_name") or item.title)
    mime_type = item.mime_type or ""
    if purpose(item) == PURPOSE_ATTACHMENT and is_image(file_name, mime_type):
        return False
    return is_archive(file_name, mime_type) or is_knowledge_format(file_name)


async def _check_movable(session: AsyncSession, item: Item) -> None:
    if is_personal(item):
        raise FailedPrecondition("A PERSONAL collection cannot move.", reason="PERSONAL_COLLECTION")
    if purpose(item) == PURPOSE_ATTACHMENT:
        raise InvalidArgument(
            "A conversation attachment stays in its owner's PERSONAL collection.",
            reason="CONVERSATION_ATTACHMENT",
        )
    if is_source_managed(item) or await is_source_candidate(session, item.id):
        raise FailedPrecondition("The source places this item.", reason="SOURCE_MANAGED")
    await require_no_open_contribution(session, item)


async def _check_publishable(session: AsyncSession, item: Item, *, published: bool) -> None:
    require_document(item, error=FailedPrecondition)
    collection = await governing_collection(session, item)
    if collection is None or is_personal(collection):
        raise FailedPrecondition("Documents in a PERSONAL collection are not published.")
    current = item.publication_state == "published"
    if current == published:
        raise FailedPrecondition(
            "The document is already " + ("PUBLISHED." if published else "UNPUBLISHED.")
        )


async def _require_on_boundaries(
    ctx: RequestContext,
    workspace_id: UUID,
    cohort: Cohort,
    root: Item,
    permission: str,
    *,
    include_deleted: bool = False,
) -> None:
    for boundary in cohort.boundaries(root):
        held = await ctx.authorizer.collection_permissions(
            ctx.principal, boundary.id, include_deleted=include_deleted
        )
        if permission not in held:
            raise FailedPrecondition(
                f"The subtree holds a collection where you lack {permission}.",
                reason="SUBTREE_HAS_FOREIGN_BOUNDARY",
                metadata={"collection": item_name(workspace_id, boundary.id)},
            )


async def _require_member(ctx: RequestContext, workspace_id: UUID, user_id: UUID, *, field: str) -> None:
    if not await ctx.authorizer.is_active_member(Principal(user_id), workspace_id):
        raise InvalidArgument.for_field(field, "The member is not an active member of this workspace.")


async def _discoverable_root(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item_id: UUID
) -> Item | None:
    """The row of a discoverable root the caller may see LOCKED, if ``item_id`` is one."""
    if not await ctx.authorizer.is_active_member(ctx.principal, workspace_id):
        return None
    item = await session.scalar(
        select(Item).where(
            Item.id == item_id, _locked_roots(workspace_id, frozenset())
        )
    )
    if item is None or await is_hidden_item(ctx, item_id):
        return None
    return item


def _locked_roots(workspace_id: UUID, readable: frozenset[UUID]) -> Any:
    return and_(
        Item.tenant_id == workspace_id,
        Item.item_type == "collection",
        Item.parent_item_id.is_(None),
        Item.deleted_at.is_(None),
        Item.metadata_["discoverable"].as_boolean().is_(True),
        Item.metadata_["system_kind"].astext.is_(None)
        | Item.metadata_["system_kind"].astext.not_in(HIDDEN_KINDS),
        Item.id.not_in(readable) if readable else literal(True),
    )


def _set_text(metadata: dict[str, Any], key: str, value: Any) -> None:
    if value:
        metadata[key] = str(value)
    else:
        metadata.pop(key, None)


def _set_flag(metadata: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        metadata.pop(key, None)
    else:
        metadata[key] = bool(value)


def _reverification_interval(workspace: Tenant) -> timedelta | None:
    value = (workspace.settings or {}).get("reverification_duration")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return None
    return timedelta(seconds=float(value))


def _revision_record(workspace_id: UUID, revision: ItemRevision) -> RevisionRecord:
    return RevisionRecord(
        workspace_id=workspace_id,
        item_id=revision.item_id,
        number=revision.revision_number,
        create_time=revision.created_at,
        mime_type=revision.mime_type,
        size_bytes=revision.size_bytes,
        change_summary=revision.summary,
        contribution_id=revision.contribution_id,
        creator_id=revision.created_by_user_id,
        external_version=revision.external_version,
        restored_from=revision.restored_from,
    )


__all__ = [
    "KnowledgeItemService",
    "append_revision_from",
    "create_document",
    "delete_item",
    "move_item",
    "publish_item",
]
