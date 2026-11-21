"""The preview engine: one representation per revision, read without converting.

Read path (GetItemPreview, the caller authorized): classify the revision's
file (:mod:`.formats`); an as-is representation is READY with the signed
original; a produced one is READY with its signed object
(``item_revisions.exports.representation``), UNAVAILABLE when the file was
recorded as failing or is over :data:`MAX_SOURCE_BYTES`, else PREPARING after
asking the worker (``pg_notify('bomesh_preview', '{item}:{revision}')``).
URLs are signed at the start of a ``url_seconds`` window (stable), so a
reopened document is served from the browser cache. The read never converts.

Produce path (ingestion worker, under the per-item ``item-preview`` lock):
make the revision's representation unless it is settled, then — for the
current revision — the cover. The original is downloaded to a temporary file
(TEXT reads only its first MiB), a producer runs within
:data:`PRODUCE_SECONDS`, the object is stored immutable at
``derived/{tenant}/{content_id}/representation-v1`` and the manifest is
recorded on the revision (a revision's content never changes); the Item's
``updateTime`` and etag never change. A failure of the file is recorded (``representation_failure``) and
not retried until the content changes; an infrastructure failure (storage,
database, Gotenberg) raises and records nothing.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar
from uuid import UUID

from sqlalchemy import and_, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Item, ItemRevision
from bomesh.services.previews.archives import produce_archive
from bomesh.services.previews.covers import (
    COVER_VERSION,
    DocumentCovers,
    cover_is_current,
    cover_plan,
)
from bomesh.services.previews.formats import Format, Producer, classify
from bomesh.services.previews.gotenberg import GotenbergClient, email_html, mhtml_html
from bomesh.services.previews.images import produce_image
from bomesh.services.previews.manifest import (
    REPRESENTATION_VERSION,
    StoredRepresentation,
    representation_failure,
    representation_key,
    stored_representation,
)
from bomesh.services.previews.results import (
    CONVERSION_ERROR,
    FORMAT_NOT_SUPPORTED,
    TIMEOUT,
    TOO_LARGE,
    ConversionFailed,
    Output,
)
from bomesh.services.previews.tables import produce_table
from bomesh.services.previews.text import TEXT_BYTES, produce_text
from bomesh.storage import DocumentStorage
from bomesh.storage.keys import IMMUTABLE_CACHE_CONTROL, content_key

log = logging.getLogger(__name__)

#: ``pg_notify`` channel of a read that found no representation: ``{item_id}:{revision_number}``.
PREVIEW_CHANNEL = "bomesh_preview"
#: Originals over this are not converted (``TOO_LARGE``); as-is ones are still shown.
MAX_SOURCE_BYTES = 100 * 1024 * 1024
#: Wall-clock bound of one local producer (a Gotenberg conversion has its own).
PRODUCE_SECONDS = 120.0

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class PreviewFile:
    """``ItemPreviewFile``: the revision's original, signed for download."""

    uri: str
    mime_type: str
    size_bytes: int
    expire_time: datetime


@dataclass(frozen=True, slots=True)
class Representation:
    """``ItemRepresentation``: what a viewer draws, signed."""

    kind: str
    uri: str
    mime_type: str
    size_bytes: int
    expire_time: datetime
    text_format: str | None = None
    language: str | None = None
    media_type: str | None = None
    #: TEXT, TABLE and ARCHIVE only.
    truncated: bool | None = None


@dataclass(frozen=True, slots=True)
class PreviewView:
    """How to show one revision: ``state`` READY, PREPARING or UNAVAILABLE."""

    state: str
    unavailable_reason: str | None
    representation: Representation | None
    original: PreviewFile


def preview_request(item_id: UUID, revision_number: int) -> str:
    """The :data:`PREVIEW_CHANNEL` payload asking for one revision's representation."""
    return f"{item_id}:{revision_number}"


def parse_preview_request(payload: str) -> tuple[UUID, int] | None:
    """``(item_id, revision_number)`` of a :data:`PREVIEW_CHANNEL` payload, else ``None``."""
    item, _, number = payload.partition(":")
    try:
        return UUID(item), int(number)
    except ValueError:
        return None


def revision_file_name(item: Item, revision: ItemRevision) -> str:
    """The file name a revision was stored under (it travels with the revision)."""
    for value in (revision.file_name, item.item_name):
        if value and value.strip():
            return value.strip()
    return str(item.id)


def revision_format(item: Item, revision: ItemRevision) -> Format | None:
    """The registry row of a revision's file; ``None``: no viewer shows it."""
    return classify(revision_file_name(item, revision), revision.mime_type)


class PreviewEngine:
    """Representations and covers of knowledge documents."""

    def __init__(
        self,
        sessions: SessionFactory,
        storage: DocumentStorage,
        gotenberg: GotenbergClient,
        *,
        url_seconds: int,
        covers: DocumentCovers | None = None,
        max_source_bytes: int = MAX_SOURCE_BYTES,
        produce_seconds: float = PRODUCE_SECONDS,
    ) -> None:
        self._sessions = sessions
        self._storage = storage
        self._gotenberg = gotenberg
        self._url_seconds = url_seconds
        self._covers = covers or DocumentCovers(sessions, storage)
        self._max_source_bytes = max_source_bytes
        self._produce_seconds = produce_seconds

    @property
    def conversions(self) -> int:
        """Gotenberg conversions this process runs at once (``BOMESH_PREVIEW_CONVERSIONS``)."""
        return self._gotenberg.conversions

    # -- Read ----------------------------------------------------------------------------

    async def read(self, session: AsyncSession, item: Item, revision: ItemRevision) -> PreviewView:
        """How to show ``revision`` of ``item`` (authorized by the caller); never converts.

        A missing representation is asked of the worker in ``session``'s
        transaction (delivered on commit); every read asks again and the
        worker's queue deduplicates.
        """
        signed = self._sign(
            content_key(item.tenant_id, revision.content_id),
            file_name=revision_file_name(item, revision),
        )
        original = PreviewFile(
            uri=signed.url,
            mime_type=revision.mime_type,
            size_bytes=revision.size_bytes,
            expire_time=signed.expires_at,
        )
        file_format = revision_format(item, revision)
        if file_format is None:
            return PreviewView("UNAVAILABLE", "FORMAT_NOT_SUPPORTED", None, original)
        if file_format.producer is Producer.AS_IS:
            representation = Representation(
                kind=file_format.kind,
                uri=original.uri,
                mime_type=file_format.mime_type or revision.mime_type,
                size_bytes=revision.size_bytes,
                expire_time=original.expire_time,
                media_type=file_format.media_type,
            )
            return PreviewView("READY", None, representation, original)
        stored = stored_representation(revision.exports)
        if stored is not None and stored.stored:
            key = representation_key(item.tenant_id, revision.content_id)
            return PreviewView("READY", None, self._representation(key, stored), original)
        failure = _failure(revision.exports)
        if failure is not None:
            reason = "TOO_LARGE" if failure == TOO_LARGE else "CONVERSION_FAILED"
            return PreviewView("UNAVAILABLE", reason, None, original)
        if revision.size_bytes > self._max_source_bytes:
            return PreviewView("UNAVAILABLE", "TOO_LARGE", None, original)
        await session.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": PREVIEW_CHANNEL, "payload": preview_request(item.id, revision.revision_number)},
        )
        return PreviewView("PREPARING", None, None, original)

    def _representation(self, key: str, stored: StoredRepresentation) -> Representation:
        signed = self._sign(key)
        bounded = stored.kind in ("TEXT", "TABLE", "ARCHIVE")
        return Representation(
            kind=stored.kind,
            uri=signed.url,
            mime_type=stored.mime_type,
            size_bytes=stored.size_bytes,
            expire_time=signed.expires_at,
            text_format=stored.text_format,
            language=stored.language,
            media_type=stored.media_type,
            truncated=stored.truncated if bounded else None,
        )

    def _sign(self, key: str, *, file_name: str | None = None) -> Any:
        return self._storage.presign_download(
            key, expires_seconds=self._url_seconds, stable=True, file_name=file_name
        )

    # -- Produce -------------------------------------------------------------------------

    async def produce(self, item_id: UUID, revision_number: int | None = None) -> bool:
        """Settle a revision's representation (``None``: the current one), then the cover.

        Whether anything was stored. The cover follows only for the current
        revision. Raises on infrastructure failures, having recorded nothing.
        """
        target = await self._target(item_id, revision_number)
        if target is None:
            return False
        item, revision, current = target
        file_format = revision_format(item, revision)
        stored = stored_representation(revision.exports)
        changed = False
        if stored is None and not _settled_failure(revision.exports, file_format):
            outcome = await self._make(item, revision, file_format)
            if not await self._record(revision.id, outcome):
                return False  # The revision went away meanwhile.
            changed = True
            stored = outcome if isinstance(outcome, StoredRepresentation) else None
        if current and not cover_is_current(revision):
            plan = cover_plan(
                file_format,
                stored,
                tenant_id=item.tenant_id,
                content_id=revision.content_id,
                size_bytes=revision.size_bytes,
            )
            changed = (await self._covers.store(item, revision, plan)) is not None or changed
        return changed

    async def pending(self, *, after: UUID | None, limit: int) -> list[UUID]:
        """Available documents whose current revision needs the engine, by ID (the sweep).

        Its cover is missing or of another producer version, or its
        representation is neither stored by this version nor recorded as failing.
        """
        exports = ItemRevision.exports
        made = exports["representation"]
        statement = (
            select(Item.id)
            .join(ItemRevision, ItemRevision.id == Item.current_revision_id)
            .where(
                Item.item_kind == "document",
                Item.deleted_at.is_(None),
                or_(
                    exports["cover"]["version"].astext.is_distinct_from(str(COVER_VERSION)),
                    and_(
                        made["version"].astext.is_distinct_from(str(REPRESENTATION_VERSION)),
                        exports["representation_failure"].is_(None),
                    ),
                ),
            )
            .order_by(Item.id)
            .limit(limit)
        )
        if after is not None:
            statement = statement.where(Item.id > after)
        async with transaction_scope(self._sessions) as session:
            return list(await session.scalars(statement))

    async def _target(
        self, item_id: UUID, revision_number: int | None
    ) -> tuple[Item, ItemRevision, bool] | None:
        """The document, the revision to settle and whether it is the current one."""
        async with transaction_scope(self._sessions) as session:
            item = await session.get(Item, item_id)
            if (
                item is None
                or item.item_kind != "document"
                or item.deleted_at is not None
                or item.current_revision_id is None
            ):
                return None
            current = await session.get(ItemRevision, item.current_revision_id)
            assert current is not None
            if revision_number is None or revision_number == current.revision_number:
                return item, current, True
            revision = await session.scalar(
                select(ItemRevision).where(
                    ItemRevision.item_id == item_id,
                    ItemRevision.revision_number == revision_number,
                    ItemRevision.deleted_at.is_(None),
                )
            )
            return (item, revision, False) if revision is not None else None

    async def _make(
        self, item: Item, revision: ItemRevision, file_format: Format | None
    ) -> StoredRepresentation | str:
        """The revision's representation, or the reason the file cannot have one."""
        if file_format is None:
            return FORMAT_NOT_SUPPORTED
        if file_format.producer is Producer.AS_IS:
            return StoredRepresentation(
                kind=file_format.kind,
                mime_type=file_format.mime_type or revision.mime_type,
                size_bytes=revision.size_bytes,
                media_type=file_format.media_type,
            )
        if revision.size_bytes > self._max_source_bytes:
            return TOO_LARGE
        file_name = revision_file_name(item, revision)
        source = content_key(item.tenant_id, revision.content_id)
        try:
            output = await self._output(source, revision.size_bytes, file_format, file_name)
        except ConversionFailed as failed:
            log.info(
                "representation failed item_id=%s revision=%s format=%s reason=%s detail=%s",
                item.id,
                revision.revision_number,
                file_format.name,
                failed.reason,
                failed,
            )
            return failed.reason
        written = await asyncio.to_thread(
            self._storage.put_bytes,
            output.data,
            representation_key(item.tenant_id, revision.content_id),
            content_type=output.mime_type,
            content_encoding=output.content_encoding,
            cache_control=IMMUTABLE_CACHE_CONTROL,
        )
        return StoredRepresentation(
            kind=file_format.kind,
            mime_type=output.mime_type,
            size_bytes=written.size_bytes,
            stored=True,
            text_format=file_format.text_format,
            language=file_format.language,
            truncated=output.truncated,
        )

    async def _output(
        self, source: str, size_bytes: int, file_format: Format, file_name: str
    ) -> Output:
        producer = file_format.producer
        if producer is Producer.TEXT:
            # Only the first MiB is ever shown: one Range read, no download.
            data = await self._storage.read_prefix(source, max_bytes=TEXT_BYTES)
            return await self._local(
                produce_text,
                data,
                complete=size_bytes <= TEXT_BYTES,
                markdown=file_format.text_format == "MARKDOWN",
                pretty_json=file_format.name == "json",
            )
        with tempfile.TemporaryDirectory(prefix="bomesh-preview-") as directory:
            path = Path(directory) / f"source.{file_format.name}"
            await self._storage.download_to_path(source, path, max_bytes=self._max_source_bytes)
            if producer is Producer.LIBREOFFICE:
                return await self._gotenberg.office_to_pdf(path, file_format.name)
            if producer is Producer.CHROMIUM:
                html = await self._local(_html_of, path, file_format.name)
                return await self._gotenberg.html_to_pdf(html)
            if producer is Producer.PILLOW:
                return await self._local(produce_image, path)
            if producer is Producer.TABLE:
                name = PurePosixPath(file_name).stem or file_name
                return await self._local(produce_table, path, file_format.name, name=name)
            if producer is Producer.ARCHIVE:
                return await self._local(produce_archive, path)
        raise AssertionError(f"no producer for {producer}")

    async def _local(self, function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        """Run a file-only producer in a thread within :data:`PRODUCE_SECONDS`.

        It reads nothing but the file, so whatever it raises is the file's.
        """
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(function, *args, **kwargs), self._produce_seconds
            )
        except ConversionFailed:
            raise
        except TimeoutError as exc:
            raise ConversionFailed(TIMEOUT, "the conversion ran out of time") from exc
        except Exception as exc:
            raise ConversionFailed(CONVERSION_ERROR, f"{type(exc).__name__}: {exc}") from exc

    async def _record(self, revision_id: UUID, outcome: StoredRepresentation | str) -> bool:
        """Write the manifest (or failure) onto the revision unless it was deleted meanwhile.

        ``item_revisions`` only: the Item row (``updateTime``, etag) is untouched.
        """
        async with transaction_scope(self._sessions) as session:
            revision = await session.scalar(
                select(ItemRevision)
                .where(ItemRevision.id == revision_id, ItemRevision.deleted_at.is_(None))
                .with_for_update()
            )
            if revision is None:
                return False
            exports = {
                key: value
                for key, value in revision.exports.items()
                if key not in ("representation", "representation_failure")
            }
            if isinstance(outcome, StoredRepresentation):
                exports["representation"] = outcome.to_json()
            else:
                exports["representation_failure"] = {"reason": outcome}
            revision.exports = exports
        return True


def _failure(exports: dict[str, Any]) -> str | None:
    """The recorded failure of the revision's content that a viewer is told about."""
    reason = representation_failure(exports)
    # Recorded while the registry lacked the format: not a property of the file.
    return None if reason == FORMAT_NOT_SUPPORTED else reason


def _settled_failure(exports: dict[str, Any], file_format: Format | None) -> bool:
    reason = representation_failure(exports)
    if reason == FORMAT_NOT_SUPPORTED:
        return file_format is None
    return reason is not None


def _html_of(path: Path, name: str) -> bytes:
    data = path.read_bytes()
    if name == "eml":
        return email_html(data)
    if name == "mht":
        return mhtml_html(data)
    return data


__all__ = [
    "MAX_SOURCE_BYTES",
    "PREVIEW_CHANNEL",
    "PRODUCE_SECONDS",
    "PreviewEngine",
    "PreviewFile",
    "PreviewView",
    "Representation",
    "parse_preview_request",
    "preview_request",
    "revision_file_name",
    "revision_format",
]
