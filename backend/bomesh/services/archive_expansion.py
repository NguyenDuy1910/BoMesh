"""Expand an uploaded ZIP archive into ordinary Documents of its Collection.

An archive is not knowledge by itself; the files inside it are. Each accepted
member becomes an upload in the archive's own Collection — the same Item,
upload record and object a person gets by uploading that file directly —
registered ``pending`` with its original stored. Expansion happens inside the
Ingestion Run that processes the archive; the run then takes the members in
as its own items, so they go through the same core as everything else. This
module knows nothing of runs or Temporal.

Children sit directly under the Collection, not under the archive Document:
retrieval scopes every chunk by its Document's Collection
(``IndexingContext.collection_item_id``), so a child nested under another
Document would be indexed out of every reader's reach. Children point back to
the archive through ``metadata["archive"]``.

Expansion is idempotent. A child's idempotency key is derived from the archive
and the member's path, and its bytes are stored only while its upload is still
pending, so a retry resumes where a failed attempt stopped; an archive already
expanded answers with the children it produced.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import joinedload

from bomesh.connector.file import FinxFileExtensions
from bomesh.connector.file.archive import (
    ArchiveError,
    ArchiveLimits,
    ArchiveListing,
    ArchiveMember,
    extract_member,
    list_archive,
)
from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.document_index import IndexProgress
from bomesh.services import DocumentProcessingError, DocumentUnavailableError
from bomesh.services.item import ItemService, document_type_for_content_type
from bomesh.storage import DocumentStorage, ObjectStorageError

log = logging.getLogger(__name__)

ARCHIVE_DOCUMENT_TYPE = "archive"
#: Skipped members kept on the archive record; the count is always complete.
_MAX_REPORTED_SKIPS = 200


@dataclass(frozen=True, slots=True)
class ArchiveExpansionResult:
    archive_id: UUID
    #: Children still waiting to be processed (not ready yet).
    document_ids: tuple[UUID, ...]
    skipped: int


class ArchiveExpansionService:
    """Own the lifecycle from stored archive to registered child Documents."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        object_storage: DocumentStorage,
        limits: ArchiveLimits = ArchiveLimits(),
    ) -> None:
        self._session_factory = session_factory
        self._object_storage = object_storage
        self._limits = limits

    async def expand_if_archive(
        self,
        document_id: UUID,
        *,
        tenant_id: UUID,
        processed_version: str,
        progress: IndexProgress | None = None,
    ) -> ArchiveExpansionResult | None:
        """Expand ``document_id`` when it is an archive; ``None`` for any other file.

        A successful expansion marks the archive processed with
        ``processed_version`` and removes it: what it held now lives in its
        Collection as ordinary pending Documents, and the archive record stays
        only as their lineage. A failed one keeps it, so the failure stays
        visible and retryable.
        """

        archive = await self._load(document_id, tenant_id=tenant_id)
        if archive.document_type != ARCHIVE_DOCUMENT_TYPE:
            return None
        assert archive.upload is not None
        owner_user_id = archive.upload.owner_user_id
        if archive.status == "deleted":
            # A retried attempt after the expansion already finished.
            summary = archive.metadata_.get("archive") or {}
            return ArchiveExpansionResult(
                archive_id=archive.id,
                document_ids=await self._waiting_children(archive.id, tenant_id=tenant_id),
                skipped=int(summary.get("skipped_count") or 0),
            )
        async with transaction_scope(self._session_factory) as session:
            await ItemService(session).mark_index_processing(archive.id)
        try:
            with tempfile.TemporaryDirectory(prefix="bomesh-archive-") as directory:
                workdir = Path(directory)
                archive_path = workdir / "archive.zip"
                if progress is not None:
                    progress("downloading", 0, 0)
                await self._download(archive, archive_path)
                listing = await asyncio.to_thread(list_archive, archive_path, self._limits)
                children: list[Item] = []
                for member in listing.members:
                    if progress is not None:
                        progress("expanding", len(children), len(listing.members))
                    children.append(
                        await self._store_child(
                            archive,
                            member,
                            archive_path=archive_path,
                            workdir=workdir,
                            owner_user_id=owner_user_id,
                        )
                    )
                if progress is not None:
                    progress("expanding", len(children), len(listing.members))
        except ArchiveError as exc:
            # The bytes are what they are; retrying cannot make them readable.
            await self._record(archive.id, status="failed", error=str(exc))
            raise DocumentProcessingError(str(exc)) from exc
        await self._record(
            archive.id,
            status="ready",
            listing=listing,
            children=children,
            processed_version=processed_version,
        )
        log.info(
            "archive expanded archive_id=%s documents=%d skipped=%d",
            archive.id,
            len(children),
            len(listing.skipped),
        )
        return ArchiveExpansionResult(
            archive_id=archive.id,
            document_ids=tuple(
                child.id
                for child in children
                if child.index_status not in {"ready", "unsupported"}
            ),
            skipped=len(listing.skipped),
        )

    async def _load(self, document_id: UUID, *, tenant_id: UUID) -> Item:
        async with transaction_scope(self._session_factory) as session:
            document = await session.scalar(
                select(Item)
                .options(joinedload(Item.upload))
                .where(
                    Item.id == document_id,
                    Item.tenant_id == tenant_id,
                    Item.item_type == "document",
                )
            )
        if document is None:
            raise DocumentUnavailableError("document was removed")
        if document.document_type == ARCHIVE_DOCUMENT_TYPE and (
            document.upload is None or document.upload.status != "available"
        ):
            raise DocumentUnavailableError("archive content is not available")
        return document

    async def _waiting_children(
        self, archive_id: UUID, *, tenant_id: UUID
    ) -> tuple[UUID, ...]:
        async with transaction_scope(self._session_factory) as session:
            return tuple(
                await session.scalars(
                    select(Item.id)
                    .where(
                        Item.tenant_id == tenant_id,
                        Item.item_type == "document",
                        Item.status != "deleted",
                        Item.deleted_at.is_(None),
                        Item.index_status.not_in(("ready", "unsupported")),
                        Item.metadata_["archive"]["document_id"].astext == str(archive_id),
                    )
                    .order_by(Item.id)
                )
            )

    async def _download(self, archive: Item, path: Path) -> None:
        if not archive.storage_key:
            raise DocumentUnavailableError("archive has no raw object storage key")
        await self._object_storage.download_to_path(
            archive.storage_key,
            path,
            max_bytes=max(archive.size_bytes or 0, 1),
        )

    async def _store_child(
        self,
        archive: Item,
        member: ArchiveMember,
        *,
        archive_path: Path,
        workdir: Path,
        owner_user_id: UUID,
    ) -> Item:
        assert archive.parent_item_id is not None
        content_type = _content_type(member.name)
        async with transaction_scope(self._session_factory) as session:
            child, _ = await ItemService(session).create_or_get_collection_upload(
                owner_user_id,
                archive.tenant_id,
                archive.parent_item_id,
                idempotency_key=_child_idempotency_key(archive.id, member.path),
                file_name=member.name,
                mime_type=content_type,
                size_bytes=member.size_bytes,
                document_type=document_type_for_content_type(content_type),
                metadata={
                    "purpose": "knowledge",
                    "archive": {
                        "document_id": str(archive.id),
                        "name": archive.title,
                        "path": member.path,
                    },
                },
            )
        assert child.upload is not None
        if child.upload.status == "available":
            return child
        if not child.storage_key:
            raise DocumentUnavailableError("child document has no object storage key")
        # The destination name is ours, never the member's: an entry name
        # cannot choose where its bytes land.
        destination = workdir / f"member-{child.id}"
        try:
            await asyncio.to_thread(
                extract_member, archive_path, member, destination, self._limits
            )
            stored = await asyncio.to_thread(
                self._object_storage.put_path,
                destination,
                child.storage_key,
                content_type=content_type,
            )
        finally:
            destination.unlink(missing_ok=True)
        if stored.size_bytes != member.size_bytes:
            # A storage fault, not a property of the archive: retryable.
            raise ObjectStorageError(
                f"{member.path} was stored with an unexpected size"
            )
        async with transaction_scope(self._session_factory) as session:
            return await ItemService(session).mark_upload_available(
                child.id,
                owner_user_id,
                archive.tenant_id,
                processable=_is_processable(member.name),
                storage_metadata={"etag": stored.etag, "version_id": stored.version_id},
            )

    async def _record(
        self,
        archive_id: UUID,
        *,
        status: str,
        listing: ArchiveListing | None = None,
        children: list[Item] | None = None,
        error: str | None = None,
        processed_version: str | None = None,
    ) -> None:
        summary: dict[str, object] = {
            "status": status,
            "expanded_at": datetime.now(UTC).isoformat(),
        }
        if listing is not None:
            summary["document_count"] = len(children or [])
            summary["skipped_count"] = len(listing.skipped)
            summary["skipped"] = [
                {"path": skip.path, "reason": skip.reason}
                for skip in listing.skipped[:_MAX_REPORTED_SKIPS]
            ]
        if error is not None:
            summary["error"] = error
        async with transaction_scope(self._session_factory) as session:
            items = ItemService(session)
            await items.merge_metadata(archive_id, {"archive": summary})
            if status == "ready":
                assert processed_version is not None
                await items.mark_index_ready(archive_id, processed_version=processed_version)
                await items.tombstone(archive_id)
            else:
                await items.mark_index_failed(archive_id)


def _child_idempotency_key(archive_id: UUID, member_path: str) -> str:
    digest = hashlib.sha256(member_path.encode("utf-8")).hexdigest()[:48]
    return f"archive:{archive_id}:{digest}"


def _content_type(file_name: str) -> str:
    guessed, _ = mimetypes.guess_type(file_name, strict=False)
    if file_name.casefold().endswith((".md", ".markdown")):
        return "text/markdown"
    return (guessed or "application/octet-stream").casefold()


def _is_processable(file_name: str) -> bool:
    """Every member but an image is processed, as for a direct upload."""

    return Path(file_name).suffix.casefold() not in FinxFileExtensions.IMAGE_EXTENSIONS


__all__ = ["ARCHIVE_DOCUMENT_TYPE", "ArchiveExpansionResult", "ArchiveExpansionService"]
