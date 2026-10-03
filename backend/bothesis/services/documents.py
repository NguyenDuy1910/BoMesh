"""The Document lifecycle, and the one place that decides who ingests an upload.

A Document is created (multipart content, or a presigned reservation that is
finalized later), its bytes land in object storage, and the shared ingestion
core processes it. Who runs that processing follows the destination:

- A user's own system Collection ("My uploads", conversation artifacts) is
  **direct**: this service runs ``ItemIngestionService.index_upload`` in the
  API process right after the bytes land. No workflow infrastructure, so the
  chat and personal-library path stays short.
- A workspace Collection is **managed**: one Temporal ingestion, with its
  retries, recovery and the live Activity monitor. Writing there already
  requires Collection write access, which is the management boundary.

Archives are bulk ingestion, so only workspace Collections accept them. The
chosen mode is recorded on the Document's Ingestion record, and every later
step (retry, monitoring) reads it from there.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from bothesis.connector.file import FinxFileExtensions
from bothesis.connector.file.archive import is_archive_name
from bothesis.db.engine import SessionFactory, transaction_scope
from bothesis.db.models import Item
from bothesis.services import (
    COLLECTION_READ_PERMISSION,
    COLLECTION_UPDATE_PERMISSION,
    DEFAULT_MAX_UPLOAD_BYTES,
    DEFAULT_UPLOAD_URL_SECONDS,
    KNOWLEDGE_READ_PERMISSION,
    AsyncUploadStream,
    AuthContext,
    CollectionUpload,
    DocumentNotFoundError,
    InvalidDocumentStateError,
    StoredFileContent,
    UploadConflictError,
    UploadStart,
    UploadTarget,
    UploadTooLargeError,
    UploadValidationError,
    require_tenant_permission,
    require_user_identity,
)
from bothesis.services.document_presentation import DocumentPresenter, document_ingestion
from bothesis.services.identity_access.authorization import AuthorizationService
from bothesis.services.item import ItemService, document_type_for_content_type
from bothesis.services.item_ingestion import ItemIngestionService
from bothesis.services.workflow import IngestionWorkflowInput
from bothesis.services.workflow.service import TemporalWorkflowService
from bothesis.storage import DocumentStorage, ObjectStorageError, StoredObject

log = logging.getLogger(__name__)

#: Direct ingestions one API process runs at once; the rest wait their turn.
_DIRECT_CONCURRENCY = 4
#: Direct ingestions an API restart may have interrupted, resumed at startup.
_RESUME_LIMIT = 500
_PURPOSES = frozenset({"knowledge", "conversation_attachment"})


def ingestion_mode(collection: Item) -> str:
    """Direct for a user's own system Collection; managed for a workspace one."""

    return "direct" if collection.metadata_.get("system_kind") else "managed"


class DocumentService:
    """Own Documents: create, finalize content, read, list, remove, re-ingest."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        object_storage: DocumentStorage,
        ingestion: ItemIngestionService,
        content: StoredFileContent,
        workflows: TemporalWorkflowService,
        presenter: DocumentPresenter,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
        upload_url_seconds: int = DEFAULT_UPLOAD_URL_SECONDS,
    ) -> None:
        if min(max_upload_bytes, upload_url_seconds) < 1:
            raise ValueError("upload limits must be greater than zero")
        self._sessions = session_factory
        self._object_storage = object_storage
        self._ingestion = ingestion
        self._content = content
        self._workflows = workflows
        self._presenter = presenter
        self.max_upload_bytes = max_upload_bytes
        self._upload_url_seconds = upload_url_seconds
        self._direct_slots = asyncio.Semaphore(_DIRECT_CONCURRENCY)
        self._direct_runs: dict[UUID, asyncio.Task[None]] = {}

    # -- Contract operations -------------------------------------------------

    async def ensure_personal_collection(self, access: AuthContext) -> dict[str, Any]:
        """Return the caller's private upload Collection, creating it once."""

        user_id = require_user_identity(access)
        tenant_id = require_tenant_permission(access, KNOWLEDGE_READ_PERMISSION)
        collection_id = ItemService.upload_collection_id(tenant_id, user_id)
        async with transaction_scope(self._sessions) as session:
            await ItemService(session).ensure_personal_collection(
                user_id,
                tenant_id,
                collection_id=collection_id,
                title="My uploads",
                system_kind="personal_uploads",
            )
            collection = await session.get(Item, collection_id)
            if collection is None:
                raise RuntimeError("personal Collection could not be created")
            return {"id": collection.id, "title": collection.title}

    async def create_document(
        self,
        access: AuthContext,
        collection_id: UUID,
        *,
        idempotency_key: str,
        name: str,
        content_type: str,
        size_bytes: int | None = None,
        purpose: str = "knowledge",
        content: AsyncUploadStream | None = None,
    ) -> dict[str, Any]:
        """Create one Document through either direct or presigned transport."""

        if content is None:
            if size_bytes is None:
                raise ValueError("size_bytes is required for presigned creation")
            reserved = await self.reserve_upload(
                access, collection_id, idempotency_key=idempotency_key,
                file_name=name, content_type=content_type, size_bytes=size_bytes,
                purpose=purpose,
            )
            return {
                "document": self._presenter.contract_document(reserved.item),
                "upload": self._presenter.upload_target(reserved.target),
                "ingestion": document_ingestion(reserved.item),
                "created": reserved.created,
            }
        stored = await self.upload_to_collection(
            access, collection_id, idempotency_key=idempotency_key,
            file_name=name, content_type=content_type, content=content, purpose=purpose,
        )
        return {
            "document": self._presenter.contract_document(stored.item),
            "upload": None,
            "ingestion": document_ingestion(stored.item),
            "created": stored.created,
        }

    async def finalize_document_content(
        self, access: AuthContext, document_id: UUID
    ) -> dict[str, Any]:
        document = await self.finalize_content(access, document_id)
        return {
            "document": self._presenter.contract_document(document),
            "ingestion": document_ingestion(document),
        }

    async def get_contract_document(
        self, access: AuthContext, document_id: UUID
    ) -> dict[str, Any]:
        return self._presenter.contract_document(await self.get_document(access, document_id))

    async def list_documents(
        self,
        access: AuthContext,
        *,
        page: int = 1,
        page_size: int = 20,
        search: str | None = None,
        collection_id: UUID | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        async with transaction_scope(self._sessions) as session:
            allowed = await AuthorizationService(session).allowed_collection_ids(access)
            if collection_id is not None:
                allowed = tuple(item for item in allowed if item == collection_id)
            statement = select(Item).where(
                Item.item_type == "document",
                Item.parent_item_id.in_(allowed),
                Item.deleted_at.is_(None),
            ).options(joinedload(Item.upload))
            if search:
                statement = statement.where(Item.title.ilike(f"%{search}%"))
            if status:
                internal_statuses = {
                    "pending_content": ("pending",),
                    "available": ("processing", "ready"),
                    "failed": ("failed", "unsupported"),
                }.get(status)
                if internal_statuses is not None:
                    statement = statement.where(Item.status.in_(internal_statuses))
            total = await session.scalar(select(func.count()).select_from(statement.subquery())) or 0
            items = list(await session.scalars(
                statement.order_by(Item.updated_at.desc(), Item.id)
                .offset((page - 1) * page_size).limit(page_size)
            ))
            return {
                "items": [self._presenter.contract_document(item) for item in items],
                "page": page,
                "page_size": page_size,
                "total": int(total),
            }

    async def delete_document(self, access: AuthContext, document_id: UUID) -> None:
        user_id = require_user_identity(access)
        async with transaction_scope(self._sessions) as session:
            document = await AuthorizationService(session).require_item(
                document_id, access=access, permission=COLLECTION_UPDATE_PERMISSION
            )
            if document.item_type != "document":
                raise DocumentNotFoundError("document not found")
            is_attachment = document.metadata_.get("purpose") == "conversation_attachment"
            if is_attachment:
                await ItemService(session).get_owned_upload(
                    document_id, user_id, access.tenant_id
                )
        if is_attachment:
            await self._ingestion.remove_upload(document_id, access=access)
        else:
            await self._ingestion.remove_item(document_id, actor=access)

    # -- Upload transports ---------------------------------------------------

    async def reserve_upload(
        self,
        access: AuthContext,
        collection_id: UUID,
        *,
        idempotency_key: str,
        file_name: str,
        content_type: str,
        size_bytes: int,
        purpose: str = "knowledge",
    ) -> UploadStart:
        """Reserve a Document and a presigned target for its bytes."""

        user_id, tenant_id = self._uploader(access, purpose)
        normalized_name = _file_name(file_name)
        normalized_type = _content_type(content_type)
        self._validate_upload_size(size_bytes)
        try:
            async with transaction_scope(self._sessions) as session:
                collection = await self._writable_collection(access, collection_id, session)
                _validate_supported_file(normalized_name, purpose, ingestion_mode(collection))
                item, created = await ItemService(session).create_or_get_collection_upload(
                    user_id, tenant_id, collection_id,
                    idempotency_key=idempotency_key, file_name=normalized_name,
                    mime_type=normalized_type, size_bytes=size_bytes,
                    document_type=_upload_document_type(normalized_name, normalized_type),
                    metadata={"purpose": purpose},
                )
        except InvalidDocumentStateError as exc:
            raise UploadConflictError(str(exc)) from exc

        assert item.upload is not None
        if item.upload.status == "available":
            await self._start_ingestion(item)
            return UploadStart(
                item=item, upload=item.upload, upload_required=False, target=None, created=created
            )
        if item.upload.status not in {"pending", "failed"}:
            raise UploadConflictError("item is not in an uploadable state")
        if not item.storage_key:
            raise UploadConflictError("item has no durable object storage key")
        request = self._object_storage.presign_upload(
            item.storage_key,
            content_type=normalized_type,
            expires_seconds=self._upload_url_seconds,
        )
        return UploadStart(
            item=item,
            upload=item.upload,
            upload_required=True,
            target=UploadTarget(mode="presigned", request=request),
            created=created,
        )

    async def upload_to_collection(
        self,
        access: AuthContext,
        collection_id: UUID,
        *,
        idempotency_key: str,
        file_name: str,
        content_type: str,
        content: AsyncUploadStream,
        purpose: str = "knowledge",
    ) -> CollectionUpload:
        """Store one file's bytes as a Document of ``collection_id`` and ingest it."""

        user_id, tenant_id = self._uploader(access, purpose)
        normalized_name = _file_name(file_name)
        normalized_type = _content_type(content_type)
        async with transaction_scope(self._sessions) as session:
            collection = await self._writable_collection(access, collection_id, session)
            mode = ingestion_mode(collection)
        _validate_supported_file(normalized_name, purpose, mode)
        temporary_path, size_bytes = await self._spool(content, normalized_name)
        try:
            try:
                async with transaction_scope(self._sessions) as session:
                    await self._writable_collection(access, collection_id, session)
                    item, created = await ItemService(session).create_or_get_collection_upload(
                        user_id,
                        tenant_id,
                        collection_id,
                        idempotency_key=idempotency_key,
                        file_name=normalized_name,
                        mime_type=normalized_type,
                        size_bytes=size_bytes,
                        document_type=_upload_document_type(normalized_name, normalized_type),
                        metadata={"purpose": purpose},
                    )
            except InvalidDocumentStateError as exc:
                raise UploadConflictError(str(exc)) from exc

            assert item.upload is not None
            if item.upload.status != "available":
                if not item.storage_key:
                    raise UploadConflictError("item has no durable object storage key")
                stored = await self._store(access, item, temporary_path, normalized_type, size_bytes)
                async with transaction_scope(self._sessions) as session:
                    item = await ItemService(session).mark_upload_available(
                        item.id,
                        user_id,
                        tenant_id,
                        ingestion_mode=mode if _is_knowledge(normalized_name) else None,
                        storage_metadata={"etag": stored.etag, "version_id": stored.version_id},
                    )
            await self._start_ingestion(item)
            return CollectionUpload(item=item, created=created)
        finally:
            temporary_path.unlink(missing_ok=True)

    async def finalize_content(self, access: AuthContext, document_id: UUID) -> Item:
        """Bind a presigned object as the Document's content and ingest it."""

        require_user_identity(access)
        if access.tenant_id is None:
            raise UploadValidationError("an active tenant is required")
        async with transaction_scope(self._sessions) as session:
            item = await ItemService(session).get_upload_for_access(
                document_id, access, permission=COLLECTION_UPDATE_PERMISSION
            )
            assert item.upload is not None
            collection = await session.get(Item, item.parent_item_id)
            if collection is None:
                raise DocumentNotFoundError(f"collection not found: {item.parent_item_id}")
            mode = ingestion_mode(collection)
        if item.upload.status == "available":
            await self._start_ingestion(item)
            return item
        if not item.storage_key:
            raise ObjectStorageError("item has no object storage key")
        try:
            stored = await self._object_storage.head(item.storage_key)
            _validate_stored_object(
                stored, expected_size=item.size_bytes, expected_content_type=item.mime_type
            )
        except (UploadValidationError, ObjectStorageError):
            await self._record_failure(access, document_id, error_code="object_validation_failed")
            raise
        file_name = str(item.metadata_.get("file_name") or item.title)
        async with transaction_scope(self._sessions) as session:
            item = await ItemService(session).mark_upload_available(
                document_id,
                item.upload.owner_user_id,
                access.tenant_id,
                ingestion_mode=mode if _is_knowledge(file_name) else None,
                storage_metadata={"etag": stored.etag, "version_id": stored.version_id},
            )
        await self._start_ingestion(item)
        return item

    # -- Ingestion -------------------------------------------------------------

    async def retry_ingestion(self, access: AuthContext, document_id: UUID) -> Item:
        """Open a new Ingestion for an available upload, in its original mode."""

        require_user_identity(access)
        document = await self.get_document(
            access, document_id, permission=COLLECTION_UPDATE_PERMISSION
        )
        if document.upload is None or document.upload.status != "available":
            raise UploadConflictError("the original file is unavailable; upload the file again")
        if document.index_status == "unsupported":
            raise UploadConflictError("images are not processed as knowledge")
        async with transaction_scope(self._sessions) as session:
            items = ItemService(session)
            collection = await session.get(Item, document.parent_item_id)
            mode = ingestion_mode(collection) if collection is not None else "managed"
            await items.restart_ingestion(document.id, ingestion_mode=mode)
            document = await items.get_upload_for_access(
                document.id, access, permission=COLLECTION_UPDATE_PERMISSION
            )
        await self._start_ingestion(document, trigger_type="retry")
        return document

    async def resume_direct_ingestions(self) -> int:
        """Restart direct ingestions an API restart interrupted.

        Direct runs live in the process that started them; their state does
        not. A run is idempotent under the core's per-document lock, so a run
        another process is still working on simply waits and then finds
        nothing to do.
        """

        async with transaction_scope(self._sessions) as session:
            documents = list(
                await session.scalars(
                    select(Item)
                    .options(joinedload(Item.upload))
                    .where(
                        Item.item_type == "document",
                        Item.status == "ready",
                        Item.deleted_at.is_(None),
                        Item.index_status.in_(("pending", "processing")),
                        Item.metadata_["ingestion"]["mode"].astext == "direct",
                    )
                    .limit(_RESUME_LIMIT)
                )
            )
        for document in documents:
            self._run_direct(document)
        return len(documents)

    async def aclose(self) -> None:
        runs = list(self._direct_runs.values())
        for run in runs:
            run.cancel()
        for run in runs:
            with suppress(asyncio.CancelledError, Exception):
                await run

    async def _start_ingestion(self, document: Item, *, trigger_type: str = "upload") -> None:
        """Hand an available upload to its runner, as its Ingestion record says."""

        if document.index_status == "unsupported" or (
            document.index_status == "ready" and trigger_type != "retry"
        ):
            return
        record = document.metadata_.get("ingestion") or {}
        if record.get("mode") == "direct":
            self._run_direct(document)
            return
        upload = document.upload
        if upload is None or upload.status != "available":
            raise InvalidDocumentStateError("cannot ingest an unavailable upload")
        try:
            await self._workflows.start_ingestion(
                IngestionWorkflowInput(
                    tenant_id=str(document.tenant_id),
                    document_id=str(document.id),
                    owner_user_id=str(upload.owner_user_id),
                    trigger_type=trigger_type,
                ),
                title=str(document.metadata_.get("file_name") or document.title),
                collection_id=str(document.parent_item_id),
            )
        except Exception:  # noqa: BLE001 - the stored bytes are durable first
            # A Temporal outage must not fail a successful upload: the record
            # stays pending and a retry remains available.
            log.exception("managed ingestion dispatch failed document_id=%s", document.id)

    def _run_direct(self, document: Item) -> None:
        if document.id in self._direct_runs or document.upload is None:
            return
        run = asyncio.create_task(
            self._ingest_directly(document.id, document.upload.owner_user_id, document.tenant_id)
        )
        self._direct_runs[document.id] = run
        run.add_done_callback(lambda _, key=document.id: self._direct_runs.pop(key, None))

    async def _ingest_directly(
        self, document_id: UUID, owner_user_id: UUID, tenant_id: UUID
    ) -> None:
        async with self._direct_slots:
            try:
                await self._ingestion.index_upload(
                    document_id,
                    owner_user_id=owner_user_id,
                    tenant_id=tenant_id,
                    source=self._content,
                )
            except Exception:  # noqa: BLE001 - the core recorded state and reason
                log.warning("direct ingestion failed document_id=%s", document_id, exc_info=True)

    # -- Internals -------------------------------------------------------------

    async def get_document(
        self,
        access: AuthContext,
        document_id: UUID,
        *,
        permission: str = COLLECTION_READ_PERMISSION,
    ) -> Item:
        if access.tenant_id is None:
            raise UploadValidationError("an active tenant is required")
        async with transaction_scope(self._sessions) as session:
            return await ItemService(session).get_upload_for_access(
                document_id, access, permission=permission
            )

    @staticmethod
    def _uploader(access: AuthContext, purpose: str) -> tuple[UUID, UUID]:
        if purpose not in _PURPOSES:
            raise UploadValidationError("unsupported document purpose")
        user_id = require_user_identity(access)
        if access.tenant_id is None:
            raise UploadValidationError("an active tenant is required")
        return user_id, access.tenant_id

    @staticmethod
    async def _writable_collection(
        access: AuthContext, collection_id: UUID, session: AsyncSession
    ) -> Item:
        collection = await AuthorizationService(session).require_item(
            collection_id, access=access, permission=COLLECTION_UPDATE_PERMISSION
        )
        if collection.item_type != "collection":
            raise DocumentNotFoundError(f"collection not found: {collection_id}")
        if collection.status != "ready":
            raise UploadValidationError("collection is unavailable for uploads")
        return collection

    async def _store(
        self,
        access: AuthContext,
        item: Item,
        path: Path,
        content_type: str,
        size_bytes: int,
    ) -> StoredObject:
        assert item.storage_key is not None
        try:
            stored = await asyncio.to_thread(
                self._object_storage.put_path, path, item.storage_key, content_type=content_type
            )
            _validate_stored_object(
                stored, expected_size=size_bytes, expected_content_type=content_type
            )
            return stored
        except UploadValidationError:
            await self._record_failure(access, item.id, error_code="object_validation_failed")
            raise
        except ObjectStorageError:
            await self._record_failure(access, item.id, error_code="object_storage_failed")
            raise
        except Exception as exc:
            await self._record_failure(access, item.id, error_code="object_storage_failed")
            raise ObjectStorageError("object storage upload failed") from exc

    async def _record_failure(
        self, access: AuthContext, document_id: UUID, *, error_code: str
    ) -> None:
        if access.tenant_id is None:
            return
        try:
            async with transaction_scope(self._sessions) as session:
                await ItemService(session).mark_upload_failed(
                    document_id,
                    require_user_identity(access),
                    access.tenant_id,
                    error_code=error_code,
                )
        except Exception:
            log.exception("upload failure state could not be persisted document_id=%s", document_id)

    async def _spool(self, content: AsyncUploadStream, file_name: str) -> tuple[Path, int]:
        temporary = tempfile.NamedTemporaryFile(
            prefix="bothesis-upload-", suffix=Path(file_name).suffix, delete=False
        )
        path = Path(temporary.name)
        size_bytes = 0
        try:
            while True:
                chunk = await content.read(min(1024 * 1024, self.max_upload_bytes + 1))
                if not chunk:
                    break
                size_bytes += len(chunk)
                self._validate_upload_size(size_bytes)
                temporary.write(chunk)
            temporary.flush()
            self._validate_upload_size(size_bytes)
            return path, size_bytes
        except Exception:
            temporary.close()
            path.unlink(missing_ok=True)
            raise
        finally:
            if not temporary.closed:
                temporary.close()

    def _validate_upload_size(self, size_bytes: int) -> None:
        if size_bytes < 1:
            raise UploadValidationError("upload size must be greater than zero")
        if size_bytes > self.max_upload_bytes:
            raise UploadTooLargeError(f"upload exceeds the {self.max_upload_bytes} byte limit")


def _file_name(value: str) -> str:
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > 240
        or normalized in {".", ".."}
        or "\x00" in normalized
        or "/" in normalized
        or "\\" in normalized
    ):
        raise UploadValidationError("file name is invalid")
    return normalized


def _content_type(value: str) -> str:
    normalized = value.split(";", 1)[0].strip().casefold()
    if not normalized or len(normalized) > 255 or "/" not in normalized:
        raise UploadValidationError("content type is invalid")
    return normalized


def _validate_supported_file(file_name: str, purpose: str, mode: str) -> None:
    if is_archive_name(file_name):
        # Expanding an archive is bulk ingestion: workspace Collections only.
        if purpose != "knowledge" or mode != "managed":
            raise UploadValidationError(
                "archives can be added to a workspace collection, not to your own uploads"
                " or a conversation"
            )
        return
    extension = Path(file_name).suffix.casefold()
    if extension in FinxFileExtensions.KNOWLEDGE_EXTENSIONS:
        return
    if extension in FinxFileExtensions.IMAGE_EXTENSIONS:
        # Images are not knowledge in this phase; a conversation may still
        # attach one for the model to look at.
        if purpose == "conversation_attachment":
            return
        raise UploadValidationError(
            "images are not supported as knowledge yet; attach them to a conversation instead"
        )
    raise UploadValidationError(
        f"unsupported file type: {extension or 'file has no extension'}"
    )


def _is_knowledge(file_name: str) -> bool:
    """Whether an upload is ingested: everything but an image attachment."""

    return Path(file_name).suffix.casefold() not in FinxFileExtensions.IMAGE_EXTENSIONS


def _upload_document_type(file_name: str, content_type: str) -> str:
    # Browsers label ZIPs as application/zip, x-zip-compressed or even
    # octet-stream, so the name decides that an upload is an archive.
    if is_archive_name(file_name):
        return "archive"
    return document_type_for_content_type(content_type)


def _validate_stored_object(
    stored: StoredObject,
    *,
    expected_size: int | None,
    expected_content_type: str | None,
) -> None:
    if expected_size is None or stored.size_bytes != expected_size:
        raise UploadValidationError("uploaded object size does not match document metadata")
    actual_type = _content_type(stored.content_type or "application/octet-stream")
    expected_type = _content_type(expected_content_type or "application/octet-stream")
    if (
        expected_type != "application/octet-stream"
        and actual_type != "application/octet-stream"
        and actual_type != expected_type
    ):
        raise UploadValidationError(
            "uploaded object content type does not match document metadata"
        )


__all__ = ["DocumentService", "ingestion_mode"]
