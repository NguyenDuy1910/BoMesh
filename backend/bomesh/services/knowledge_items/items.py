"""Items: create, upload, read, list, update and the lifecycle custom methods.

``item_model.md`` §4 and §7 decide every rule here; the engine
(:mod:`bomesh.services.knowledge_items.item_store`) changes rows, this service authorizes,
validates, audits and re-applies index payloads after commit.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, case, false, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Concept, ConceptScheme, Item, ItemRevision, ItemUpload, Tenant
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
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import require_restorable
from bomesh.services.kernel.workspaces import workspace_name
from bomesh.services.knowledge_items.collection_import import (
    FolderPlanner,
    load_folders,
)
from bomesh.services.knowledge_items.file_types import (
    ITEM_TYPE_MISMATCH,
    ItemTypeMismatchError,
    file_class,
)
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_TYPES,
    PURPOSE_ATTACHMENT,
    PURPOSE_KNOWLEDGE,
    Cohort,
    ItemService,
    catalog_visibility,
    is_knowledge_format,
    is_personal,
    is_source_candidate,
    is_source_managed,
    item_content_key,
    purpose,
)
from bomesh.services.knowledge_items.merge import repoint_references
from bomesh.services.knowledge_items.names import (
    item_name,
    parse_item,
)
from bomesh.services.knowledge_items.records import (
    Applicability,
    CollectionImportChange,
    CollectionImportResult,
    CollectionImportRow,
    ConceptKey,
    Issuance,
    ItemPage,
    ItemRecord,
    NewDocument,
    NewItem,
    RevisionRecord,
    UploadedFile,
)
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
from bomesh.services.taxonomy.assignments import ConceptEntry, set_document_concepts
from bomesh.services.taxonomy.profiles import (
    ApplicabilityInput,
    IssuanceInput,
    set_applicability,
    set_issuance,
)
from bomesh.services.taxonomy.names import concept_name
from bomesh.storage import ObjectNotFoundError, ObjectStorageError
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, content_key

MAX_DISPLAY_NAME = 512

#: UpdateItem paths and the permission each needs besides ``items.update``.
COLLECTION_PATHS = frozenset(
    {
        "collection.description",
        "collection.discoverable",
        "collection.acceptsContributions",
        "collection.inheritAccess",
    }
)
DOCUMENT_PATHS = frozenset(
    {
        "document.concepts",
        "document.issuance",
        "document.applicability",
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
        item_id = await self.store_media(
            ctx, workspace_id, spec, file, request_id=request_id, published=published
        )
        return await self.get(ctx, workspace_id, item_id)

    async def store_media(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        spec: NewItem,
        file: UploadedFile,
        *,
        request_id: UUID | None,
        published: bool = True,
    ) -> UUID:
        """:meth:`create_media` without projecting the response: the new document's id."""
        if spec.item_kind != "document" or spec.document is None:
            raise InvalidArgument.for_field(
                "metadata.itemKind", "A media upload creates a DOCUMENT."
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
            item_kind=spec.item_kind,
            display_name=spec.display_name,
            parent_id=spec.parent_id,
            document=type(document)(
                mime_type=document.mime_type or file.content_type,
                file_name=document.file_name or file.file_name,
                size_bytes=len(file.data),
                purpose=document.purpose,
                summary=document.summary,
                language_code=document.language_code,
                owner_id=document.owner_id,
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
            assert item is not None and item.content_id is not None and item.mime_type is not None
            pending = item.content_state != "available"
            key = content_key(item.workspace_code, item.content_id)
            mime_type = item.mime_type
        if pending:
            try:
                stored = await asyncio.to_thread(
                    self._deps.storage.put_bytes,
                    file.data,
                    key,
                    content_type=mime_type,
                    cache_control=IMMUTABLE_CACHE_CONTROL,
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
                )
        return item_id

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
        source: ItemRevision | None = None,
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
            if parent is not None and parent.item_kind != "collection":
                raise InvalidArgument.for_field(
                    "parentItem", "parentItem must be a COLLECTION."
                )
            if spec.item_kind == "collection":
                item = await self._create_collection(session, ctx, workspace_id, spec, parent)
            else:
                if parent is None:
                    raise InvalidArgument.for_field(
                        "parentItem", "A DOCUMENT needs a parentItem."
                    )
                item = await self._create_document(
                    session, ctx, workspace_id, spec, parent, published=published, source=source
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
        if parent is None and facet is not None and facet.inherit_access:
            raise InvalidArgument.for_field(
                "collection.inheritAccess", "A root collection is always an access boundary."
            )
        items = ItemService(session)
        item = await items.create_collection(
            workspace_id=workspace_id,
            item_name=spec.display_name,
            created_by_user_id=ctx.user_id,
            parent_item_id=parent.id if parent is not None else None,
            inherit_access=True if facet is None or facet.inherit_access is None else facet.inherit_access,
            description=(facet.description or None) if facet is not None else None,
            discoverable=bool(facet is not None and facet.discoverable),
            accepts_contributions=bool(facet is not None and facet.accepts_contributions),
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
        source: ItemRevision | None = None,
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
        if facet.owner_id is not None:
            await _require_member(ctx, workspace_id, facet.owner_id, field="document.owner")
        item = await ItemService(session).create_document(
            workspace_id=workspace_id,
            parent=parent,
            item_name=spec.display_name,
            mime_type=mime_type,
            size_bytes=facet.size_bytes,
            file_name=file_name,
            purpose=facet.purpose,
            published=published,
            created_by_user_id=ctx.user_id,
            uploader_user_id=None if source is not None else ctx.user_id,
            description=facet.summary or None,
            language_code=facet.language_code or None,
            owner_user_id=facet.owner_id,
        )
        if source is not None:
            await self._reuse(session, workspace_id, item, source, ctx=ctx)
        return item

    @staticmethod
    async def _reuse(
        session: AsyncSession,
        workspace_id: UUID,
        item: Item,
        source: ItemRevision,
        *,
        ctx: RequestContext,
    ) -> None:
        """Revision 1 of a new document shows ``source``'s content (no bytes are copied)."""
        tenant = await session.scalar(select(Item.tenant_id).where(Item.id == source.item_id))
        if tenant != workspace_id or source.deleted_at is not None:
            raise FailedPrecondition("The source revision is not available in this workspace.")
        items = ItemService(session)
        try:
            await items.append_revision(
                item,
                content_id=source.content_id,
                mime_type=source.mime_type,
                size_bytes=source.size_bytes,
                file_name=source.file_name,
                created_by_user_id=ctx.user_id,
                reuses=source,
            )
        except ItemTypeMismatchError as error:
            raise InvalidArgument.for_field(
                "document.mimeType", str(error), reason=ITEM_TYPE_MISMATCH
            ) from None
        if not _processable(item):
            await items.set_index_state((item,), index_status="unsupported")

    async def complete_upload(
        self, ctx: RequestContext, workspace_id: UUID, item_id: UUID, *, etag: str | None
    ) -> ItemRecord:
        """CompleteItemUpload: validate the stored object and record revision 1."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.create", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(session, ctx, workspace_id, item_id, permission="items.create")
            if item.item_kind != "document":
                raise FailedPrecondition("A COLLECTION has no content to upload.")
            if item.created_by_user_id != ctx.user_id:
                raise permission_denied("items.create", ItemRef(workspace_id, item_id))
            check_etag(item, etag)
            if item.content_state == "available":
                return await self._record(session, ctx, workspace_id, item)
            await require_no_open_contribution(session, item)
            upload = await session.get(ItemUpload, item.id)
            if upload is None:
                raise FailedPrecondition("The document has no upload.")
            key = content_key(item.workspace_code, upload.content_id)
            expected_size, expected_type = upload.size_bytes, upload.mime_type
            file_name, item_type = upload.file_name, item.item_type
        try:
            stored = await self._deps.storage.head(key)
        except ObjectNotFoundError:
            raise FailedPrecondition(
                "The file has not been uploaded yet.", reason="UPLOAD_INCOMPLETE"
            ) from None
        error_code = _upload_error(
            stored.size_bytes,
            stored.content_type,
            expected_size=expected_size,
            expected_type=expected_type,
            file_name=file_name,
            item_type=item_type,
        )
        async with transaction_scope(self._deps.sessions) as session:
            item = await session.get(Item, item_id, with_for_update=True, populate_existing=True)
            assert item is not None
            items = ItemService(session)
            if item.content_state != "available":
                if error_code is None:
                    await items.mark_upload_available(
                        item,
                        size_bytes=stored.size_bytes,
                        processable=_processable(item),
                    )
                else:
                    await items.mark_upload_failed(item, error_code=error_code)
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="knowledge",
                    action="CompleteItemUpload",
                    target=item_name(workspace_id, item_id),
                    outcome="succeeded" if error_code is None else "failed",
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
                return Projector.locked(locked)
            return await self._record(session, ctx, workspace_id, item, full=full)

    async def media_url(self, ctx: RequestContext, workspace_id: UUID, item_id: UUID) -> str:
        """GetItem ``alt=media``: a short-lived signed URL of the current revision's original."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_content_source(
                session, ctx, workspace_id, item_id, reviewer_exception=True
            )
        if item.item_kind != "document":
            raise InvalidArgument.for_field("alt", "alt=media applies to DOCUMENT items only.")
        if item.current_revision_id is None:
            raise FailedPrecondition("The document has no stored content yet.")
        return self._deps.storage.presign_download(
            item_content_key(item),
            expires_seconds=self._deps.download_url_seconds,
            file_name=item.file_name,
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
            records = await self._page(
                session, ctx, workspace_id, query, visibility, full=full, show_locked=show_locked
            )
            scope = _list_scope(workspace_id, query, visibility.clause(), visibility, show_locked)
            total = await session.scalar(
                select(func.count()).select_from(select(Item.id).where(scope).subquery())
            )
        return ItemPage(items=records, total_size=int(total or 0))

    async def page(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        query: ListQuery,
        visibility: ItemVisibility,
        *,
        show_locked: bool = False,
    ) -> list[ItemRecord]:
        """ListItems' page without ``totalSize``, under the caller's ``visibility``
        (their :func:`catalog_visibility` of the workspace): for read models like Home."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "items.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            return await self._page(
                session, ctx, workspace_id, query, visibility, full=False, show_locked=show_locked
            )

    async def _page(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        query: ListQuery,
        visibility: ItemVisibility,
        *,
        full: bool,
        show_locked: bool,
    ) -> list[ItemRecord]:
        visible = visibility.clause()
        if show_locked:
            # LOCKED discoverable roots sort after the visible rows, by name.
            readable: ColumnElement[Any] = case((visible, 1), else_=0)
            first: tuple[Any, ...] = (
                readable.desc(),
                case((visible, literal("")), else_=Item.item_name),
            )
        else:
            readable, first = literal(1), ()
        statement = (
            select(Item, readable)
            .where(_list_scope(workspace_id, query, visible, visibility, show_locked))
            .order_by(*first, *query.order_by)
            .offset(query.offset)
            .limit(query.limit)
        )
        rows = (await session.execute(statement)).all()
        # Counts and ancestors use the live visibility, whatever showDeleted is.
        projector = Projector(
            session,
            ctx,
            workspace_id,
            self._deps,
            visibility=replace(visibility, restorable=frozenset(), restorable_editable=frozenset()),
        )
        projected = iter(
            await projector.project_many([row for row, shown in rows if shown], full=full)
        )
        return [next(projected) if shown else Projector.locked(row) for row, shown in rows]

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
            facet_paths = COLLECTION_PATHS if item.item_kind == "collection" else DOCUMENT_PATHS
            for path in changes:
                if path != "displayName" and path not in facet_paths:
                    raise InvalidArgument.for_field(
                        "updateMask", f"{path} does not apply to a {item.item_kind.upper()}."
                    )
            for path, value in changes.items():
                await self._apply_change(session, ctx, workspace_id, item, path, value)
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
        path: str,
        value: Any,
    ) -> None:
        match path:
            case "displayName":
                _validate_display_name(value or "")
                item.item_name = value
            case "collection.description" | "document.summary":
                item.description = _text(value)
            case "document.languageCode":
                item.language_code = _text(value)
            case "collection.discoverable":
                if value and item.parent_item_id is not None:
                    raise InvalidArgument.for_field(
                        "collection.discoverable", "Only root collections are discoverable."
                    )
                item.discoverable = bool(value)
            case "collection.acceptsContributions":
                item.accepts_contributions = bool(value)
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
            case "document.concepts":
                entries = [
                    ConceptEntry(
                        concept_id=await _concept_id(
                            session, workspace_id, choice.concept, field="document.concepts"
                        ),
                        primary=choice.primary,
                    )
                    for choice in value or ()
                ]
                await set_document_concepts(session, ctx, item.id, entries)
            case "document.issuance":
                await set_issuance(
                    session, item.id, workspace_id, await _issuance_input(session, workspace_id, value)
                )
            case "document.applicability":
                await set_applicability(
                    session,
                    item.id,
                    workspace_id,
                    await _applicability_input(session, workspace_id, value),
                )
            case "document.owner":
                if value is None:
                    item.owner_user_id = None
                    return
                await _require_member(ctx, workspace_id, value, field="document.owner")
                item.owner_user_id = value

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
            if item.item_kind == "collection" and not force and await items.has_live_children(item.id):
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
            if item.item_kind != "collection":
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
        if destination.item_kind != "collection":
            raise InvalidArgument.for_field(
                "destinationParent", "destinationParent must be a COLLECTION."
            )
        if is_personal(destination):
            if destination.created_by_user_id != ctx.user_id:
                raise permission_denied("items.create", ItemRef(workspace_id, destination.id))
            if item.item_kind != "document":
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
        if item.item_kind == "collection" and not item.inherit_access:
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
            if not item.is_published:
                raise FailedPrecondition("Only a PUBLISHED document can be verified.")
            now = await session.scalar(select(func.now()))
            assert now is not None
            interval = _reverification_interval(workspace)
            item.verified_by_user_id = ctx.user_id
            item.verified_at = now
            item.next_review_at = now + interval if interval is not None else None
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
        """MergeItem: every reference to this duplicate moves to the target, then it is deleted."""
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item = await load_item(
                session, ctx, workspace_id, item_id, permission="items.delete", for_update=True
            )
            require_document(item, error=FailedPrecondition)
            target = await load_referenced(
                session, ctx, workspace_id, target_id, permission=EDIT, include_deleted=True
            )
            if target.id == item.id or target.item_kind != "document" or target.deleted_at is not None:
                raise FailedPrecondition(
                    "targetItem must be another live DOCUMENT."
                )
            await require_no_open_contribution(session, item)
            check_etag(item, etag)
            items = ItemService(session)
            cohort = await items.live_subtree(item)
            if target.id in cohort.ids:
                raise FailedPrecondition("targetItem must not lie below the merged DOCUMENT.")
            await repoint_references(session, item.id, target)
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

    # -- Import -----------------------------------------------------------------

    async def import_collections(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item_id: UUID,
        rows: Sequence[CollectionImportRow],
        *,
        validate_only: bool,
    ) -> CollectionImportResult:
        """ImportCollections: create a folder tree's missing folders under a collection.

        Rows name folders by display-name paths matched against the readable live
        child collections (:class:`FolderPlanner`); a row that cannot apply is
        skipped with its reason. The outcome is computed in memory; ``validateOnly``
        stops there (no write, no row lock), a real import then creates the folders
        parents first, exactly like CreateItem folders.
        """
        await self._deps.workspaces.open(ctx, ItemRef(workspace_id, item_id), "items.create", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            target = await load_item(
                session,
                ctx,
                workspace_id,
                item_id,
                permission="items.create",
                for_update=not validate_only,
            )
            if target.item_kind != "collection":
                raise InvalidArgument.for_field("item", "Folders are imported into a COLLECTION.")
            visibility = await catalog_visibility(
                session, ctx.authorizer, ctx.principal, workspace_id
            )
            tree = await load_folders(
                session, ctx.authorizer, ctx.principal, visibility, target, rows
            )
            plan = FolderPlanner(tree, max_name=MAX_DISPLAY_NAME).plan_rows(rows)
            if not validate_only and plan.new:
                items = ItemService(session)
                for new in plan.new:
                    created = await items.create_collection(
                        workspace_id=workspace_id,
                        item_name=new.name,
                        created_by_user_id=ctx.user_id,
                        parent_item_id=new.parent.item_id,
                        inherit_access=True,
                        description=new.description,
                        discoverable=False,
                        accepts_contributions=False,
                    )
                    new.folder.item_id = created.id
                await Audit(session).record(
                    ctx,
                    workspace_id=workspace_id,
                    category="knowledge",
                    action="ImportCollections",
                    target=item_name(workspace_id, item_id),
                    details={"createdCount": len(plan.new)},
                )
            return CollectionImportResult(
                created=tuple(
                    CollectionImportChange(item_id=new.folder.item_id, path=new.path, row=new.row)
                    for new in plan.new
                ),
                unchanged_count=plan.unchanged,
                skipped=tuple(plan.skipped),
            )

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
            if await is_source_managed(session, item):
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
                content_id=revision.content_id,
                mime_type=revision.mime_type,
                size_bytes=revision.size_bytes,
                file_name=revision.file_name,
                created_by_user_id=ctx.user_id,
                restored_from=number,
                reuses=revision,
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
        return await Projector(session, ctx, workspace_id, self._deps).project(item, full=full)

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
    file: UploadedFile | ItemRevision,
    *,
    display_name: str,
    purpose: str = PURPOSE_KNOWLEDGE,
    published: bool = True,
    request_id: UUID | None = None,
) -> UUID:
    """A new DOCUMENT holding ``file`` under ``parent_id``, as the caller (``items.create``);
    returns its id.

    The CreateItemMedia pipeline: same format rules, the bytes stored and the
    document AVAILABLE with revision 1; nothing is processed. An existing
    revision (an artifact published as a Document) is reused, never copied:
    revision 1 shows its content and starts with its derived exports.
    """
    if isinstance(file, ItemRevision):
        spec = NewItem(
            item_kind="document",
            display_name=display_name,
            parent_id=parent_id,
            document=NewDocument(
                mime_type=file.mime_type,
                file_name=file.file_name,
                size_bytes=file.size_bytes,
                purpose=purpose,
            ),
        )
        return await items._create(
            ctx,
            workspace_id,
            spec,
            request_id=request_id,
            method="CreateItemMedia",
            digest=f"revision:{file.id}",
            published=published,
            source=file,
        )
    spec = NewItem(
        item_kind="document",
        display_name=display_name,
        parent_id=parent_id,
        document=NewDocument(
            mime_type=file.content_type,
            file_name=file.file_name or display_name,
            purpose=purpose,
        ),
    )
    return await items.store_media(
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
    if destination.item_kind != "collection" or destination.deleted_at is not None:
        raise InvalidArgument("The destination must be a live COLLECTION.")
    return await ItemService(session).move(item, destination)


async def publish_item(session: AsyncSession, workspace_id: UUID, item_id: UUID) -> tuple[UUID, ...]:
    """Publish a document (contribution approval); returns dirty payloads."""
    item = await _row(session, workspace_id, item_id, for_update=True)
    require_document(item, error=FailedPrecondition)
    if not item.is_published:
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
    number. The caller deletes the candidate (:func:`delete_item`). Content of
    another file class than ``target`` → FAILED_PRECONDITION ITEM_TYPE_MISMATCH.
    """
    candidate = await session.get(Item, candidate_id)
    target = await session.get(Item, target_id, with_for_update=True)
    if candidate is None or target is None or candidate.tenant_id != target.tenant_id:
        raise NotFound("The candidate or the replaced document does not exist.")
    require_document(candidate, error=FailedPrecondition)
    require_document(target, error=FailedPrecondition)
    source = await ItemService(session).current_revision(candidate.id)
    if source is None:
        raise FailedPrecondition("The candidate has no available content.")
    try:
        revision = await ItemService(session).append_revision(
            target,
            content_id=source.content_id,
            mime_type=source.mime_type,
            size_bytes=source.size_bytes,
            file_name=source.file_name,
            reuses=source,
            created_by_user_id=created_by_user_id,
            contribution_id=contribution_id,
            summary=summary,
        )
    except ItemTypeMismatchError as error:
        raise FailedPrecondition(str(error), reason=ITEM_TYPE_MISMATCH) from None
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
    content_type = file_class(mime_type, file_name)
    allowed = True
    if purpose == PURPOSE_ATTACHMENT:
        allowed = own_personal and content_type != "archive"
    elif content_type == "image":
        allowed = False
    elif content_type == "archive":
        allowed = not is_personal(parent)
    if not allowed:
        raise InvalidArgument(
            "This file format is not allowed here.", reason="FORMAT_NOT_ALLOWED"
        )


def _upload_error(
    size_bytes: int,
    content_type: str | None,
    *,
    expected_size: int | None,
    expected_type: str,
    file_name: str,
    item_type: str,
) -> str | None:
    """Why a stored object does not validate against its upload (``None`` = it does).

    Content of another file class than the document's is ``ITEM_TYPE_MISMATCH``;
    any other size or MIME difference is ``OBJECT_INVALID``.
    """
    stored_type = content_type.split(";", 1)[0].strip().casefold() if content_type else None
    if stored_type is not None and file_class(stored_type, file_name) != item_type:
        return ITEM_TYPE_MISMATCH
    if size_bytes != expected_size or stored_type not in (None, expected_type):
        return "OBJECT_INVALID"
    return None


def _processable(item: Item) -> bool:
    """Knowledge formats and archives wait for a run; anything else stays UNSUPPORTED."""
    if purpose(item) == PURPOSE_ATTACHMENT and item.item_type == "image":
        return False
    return item.item_type == "archive" or is_knowledge_format(item.file_name or item.item_name)


async def _check_movable(session: AsyncSession, item: Item) -> None:
    if is_personal(item):
        raise FailedPrecondition("A PERSONAL collection cannot move.", reason="PERSONAL_COLLECTION")
    if purpose(item) == PURPOSE_ATTACHMENT:
        raise InvalidArgument(
            "A conversation attachment stays in its owner's PERSONAL collection.",
            reason="CONVERSATION_ATTACHMENT",
        )
    if await is_source_managed(session, item) or await is_source_candidate(session, item.id):
        raise FailedPrecondition("The source places this item.", reason="SOURCE_MANAGED")
    await require_no_open_contribution(session, item)


async def _check_publishable(session: AsyncSession, item: Item, *, published: bool) -> None:
    require_document(item, error=FailedPrecondition)
    collection = await governing_collection(session, item)
    if collection is None or is_personal(collection):
        raise FailedPrecondition("Documents in a PERSONAL collection are not published.")
    current = bool(item.is_published)
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


async def _concept_id(
    session: AsyncSession, workspace_id: UUID, key: ConceptKey, *, field: str
) -> UUID:
    """The concept ``key`` (scheme code, notation) names in this workspace."""
    scheme_code, notation = key
    concept_id = await session.scalar(
        select(Concept.id)
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(
            ConceptScheme.tenant_id == workspace_id,
            ConceptScheme.deleted_at.is_(None),
            ConceptScheme.code == scheme_code,
            Concept.notation == notation,
            Concept.deleted_at.is_(None),
        )
    )
    if concept_id is None:
        raise InvalidArgument.for_field(
            field, f"'{concept_name(workspace_id, scheme_code, notation)}' does not exist."
        )
    return concept_id


async def _issuance_input(
    session: AsyncSession, workspace_id: UUID, issuance: Issuance | None
) -> IssuanceInput:
    """UpdateItem ``document.issuance`` with concepts resolved; None clears it."""
    if issuance is None:
        return IssuanceInput()
    return IssuanceInput(
        issuer_id=(
            await _concept_id(session, workspace_id, issuance.issuer, field="document.issuance.issuer")
            if issuance.issuer
            else None
        ),
        campus_id=(
            await _concept_id(session, workspace_id, issuance.campus, field="document.issuance.campus")
            if issuance.campus
            else None
        ),
        number=_text(issuance.number),
        issued_on=issuance.issued_on,
        effective_on=issuance.effective_on,
        supersedes=issuance.supersedes,
    )


async def _applicability_input(
    session: AsyncSession, workspace_id: UUID, applicability: Applicability | None
) -> ApplicabilityInput:
    """UpdateItem ``document.applicability`` with concepts resolved; None clears it."""
    if applicability is None:
        return ApplicabilityInput()
    return ApplicabilityInput(
        level=applicability.level,
        unit_ids=tuple(
            [
                await _concept_id(session, workspace_id, key, field="document.applicability.units")
                for key in applicability.units
            ]
        ),
        program_ids=tuple(
            [
                await _concept_id(
                    session, workspace_id, key, field="document.applicability.programs"
                )
                for key in applicability.programs
            ]
        ),
        cohorts=applicability.cohorts,
    )


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


def _list_scope(
    workspace_id: UUID,
    query: ListQuery,
    visible: ColumnElement[bool],
    visibility: ItemVisibility,
    show_locked: bool,
) -> ColumnElement[bool]:
    """ListItems' rows: ``query.where`` over visible items, plus LOCKED discoverable roots."""
    locked = _locked_roots(workspace_id, visibility.readable) if show_locked else false()
    return and_(query.where, or_(visible, locked))


def _locked_roots(workspace_id: UUID, readable: frozenset[UUID]) -> Any:
    return and_(
        Item.tenant_id == workspace_id,
        Item.item_kind == "collection",
        Item.parent_item_id.is_(None),
        Item.deleted_at.is_(None),
        Item.discoverable,
        Item.item_type.not_in(HIDDEN_TYPES),
        Item.id.not_in(readable) if readable else literal(True),
    )


def _text(value: Any) -> str | None:
    return str(value) if value else None


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
