"""The storage engine of Assistant artifacts (``workspaces/{w}/artifacts/{a}``).

An artifact is a DOCUMENT Item in its owner's hidden ``conversation_artifacts``
collection plus its ``artifacts`` facet row (artifact ID = item ID): the title,
MIME type and content pointer live on the Item, every content version is an
``item_revisions`` row (``author`` ASSISTANT or USER) whose object is never
rewritten, and an EVIDENCE_REVIEW matrix is ``artifacts.evidence_review`` plus
``evidence_review_cells``; each revision of a matrix freezes it as a JSON object.

Nothing here authorizes: ``bomesh.services.artifacts`` does, and the
session-taking functions run inside its transaction. :class:`ArtifactService`
is the process-wide part: object storage, first-read revision previews, the
running generation tasks, and the agent boundary (:meth:`ArtifactService.record_generated`
for a sandbox export during a turn, :meth:`ArtifactService.source_file` for a
sandbox materialization).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Callable, Coroutine, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import (
    Artifact,
    ArtifactSourceItem,
    EvidenceReviewCell,
    Item,
    ItemRevision,
)
from bomesh.iam import ItemRef, WorkspaceAccess
from bomesh.iam.visibility import is_visible, require_visible_item
from bomesh.services import (
    ARTIFACT_MIME_TYPE,
    ArtifactValidationError,
    DocumentProcessingError,
    InvalidDocumentStateError,
    PreviewManifest,
    StoredFileContent,
)
from bomesh.services.knowledge_items.item_store import (
    HIDDEN_KINDS,
    ItemService,
    new_revision_object_key,
)
from bomesh.services.knowledge_items.preview import KnowledgePreview, parse_manifest
from bomesh.services.workspaces.audit_log import AuditService
from bomesh.storage import DocumentStorage

log = logging.getLogger(__name__)

#: The object of every EVIDENCE_REVIEW revision: the frozen matrix.
EVIDENCE_REVIEW_MIME_TYPE = "application/json"
MAX_TITLE_LENGTH = 512
_MAX_SOURCE_DOCUMENT_BYTES = 20 * 1024 * 1024
_DEFAULT_OUTPUT_NAME = "document"
_DEFAULT_MIME_TYPE = "application/octet-stream"
# The file extensions a produced file is named by when the sandbox reported no
# usable content type; anything else is stored as opaque bytes.
_MIME_TYPES = {
    ".md": ARTIFACT_MIME_TYPE,
    ".markdown": ARTIFACT_MIME_TYPE,
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".zip": "application/zip",
}


@dataclass(frozen=True, slots=True)
class GeneratedArtifact:
    """The FILE artifact revision a sandbox export produced."""

    artifact_id: UUID
    name: str
    display_name: str
    file_name: str
    mime_type: str
    revision: int
    size_bytes: int
    update_time: datetime


@dataclass(frozen=True, slots=True)
class WorkspaceSource:
    """One stored document, ready to be written into an execution workspace."""

    document_id: str
    title: str
    file_name: str
    mime_type: str
    data: bytes

    @property
    def size_bytes(self) -> int:
        return len(self.data)


@dataclass(frozen=True, slots=True)
class RevisionPreview:
    """A revision as the document viewer reads it: the transient document and its manifest."""

    document: Item
    manifest: PreviewManifest


class ArtifactService:
    """Objects, previews, running generations and the agent boundary of artifacts."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        object_storage: Callable[[], DocumentStorage],
        preview: Callable[[], KnowledgePreview],
        stored_content: Callable[[], StoredFileContent],
        max_content_bytes: int,
        download_url_seconds: int,
    ) -> None:
        if min(max_content_bytes, download_url_seconds) < 1:
            raise ValueError("artifact limits must be greater than zero")
        self._sessions = session_factory
        self._object_storage = object_storage
        self._preview = preview
        self._stored_content = stored_content
        self.max_content_bytes = max_content_bytes
        self.download_url_seconds = download_url_seconds
        self._jobs: dict[UUID, asyncio.Task[None]] = {}

    @property
    def preview(self) -> KnowledgePreview:
        return self._preview()

    # -- Objects --------------------------------------------------------------

    async def put_object(self, key: str, data: bytes, mime_type: str) -> None:
        await asyncio.to_thread(self._object_storage().put_bytes, data, key, content_type=mime_type)

    async def read_object(self, key: str) -> bytes:
        return await self._object_storage().read(key, max_bytes=self.max_content_bytes)

    def download_uri(self, key: str) -> str:
        return self._object_storage().presign_download(
            key, expires_seconds=self.download_url_seconds
        ).url

    # -- Previews -------------------------------------------------------------

    async def revision_preview(self, item: Item, revision: ItemRevision) -> RevisionPreview | None:
        """The viewer manifest of one revision, built on its first read and then reused.

        A revision is an immutable original, so it is previewed by the same
        parse and preview pipeline as documents; the manifest is kept in
        ``item_revisions.exports.preview``. Markdown is its own view and gets
        none; an image needs no parse, the original is shown.
        """
        if revision.mime_type == ARTIFACT_MIME_TYPE:
            return None
        preview = self._preview()
        document = revision_document(item, revision)
        if not revision.mime_type.startswith("image/") and not (
            await preview.has_current_rendition(document)
        ):
            manifest = await self._generate_preview(item, revision, document)
            if manifest is not None:
                document.metadata_ = {
                    **document.metadata_,
                    "preview": await self._record_preview(item, revision, manifest),
                }
        manifest = parse_manifest(document.metadata_.get("preview"))
        return RevisionPreview(document, manifest) if manifest is not None else None

    async def _generate_preview(
        self, item: Item, revision: ItemRevision, document: Item
    ) -> PreviewManifest | None:
        try:
            try:
                content = (await self._stored_content().canonicalize(document)).item
            except DocumentProcessingError:
                # Unparsable content still gets its PDF pages, if it has any.
                content = None
            return await self._preview().generate(document, content=content)
        except Exception as exc:  # noqa: BLE001 - a preview is best effort
            log.warning(
                "artifact preview generation failed artifact_id=%s revision=%s error_type=%s",
                item.id,
                revision.revision_number,
                type(exc).__name__,
            )
            return None

    async def _record_preview(
        self, item: Item, revision: ItemRevision, manifest: PreviewManifest
    ) -> dict[str, Any]:
        payload = manifest.model_dump(mode="json")
        async with transaction_scope(self._sessions) as session:
            await ItemService(session).record_revision_preview(
                item.id, revision.revision_number, payload
            )
        return payload

    # -- Running generations -------------------------------------------------

    def start(self, operation_id: UUID, work: Coroutine[Any, Any, None]) -> None:
        """Run ``work`` for ``operation_id`` in the background; it settles the operation."""
        task = asyncio.create_task(work, name=f"artifact-operation-{operation_id}")
        self._jobs[operation_id] = task
        task.add_done_callback(lambda _: self._jobs.pop(operation_id, None))

    def cancel(self, operation_id: UUID) -> bool:
        """Stop the work of a cancelled operation; ``False`` if none is running here."""
        task = self._jobs.get(operation_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def aclose(self) -> None:
        """Shutdown: stop every running generation and let each settle its operation."""
        tasks = list(self._jobs.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- Agent boundary --------------------------------------------------------

    async def record_generated(
        self,
        access: WorkspaceAccess,
        *,
        conversation_id: UUID | None,
        file_name: str,
        mime_type: str,
        data: bytes,
        summary: str,
        source_ids: Sequence[UUID] = (),
    ) -> GeneratedArtifact:
        """Persist one file the agent produced as a FILE artifact of the caller.

        A conversation keeps one artifact per file name, so writing
        ``report.xlsx`` a second time is revision 2 of the same artifact: the
        user sees one card with a history instead of near-identical files.
        ``source_ids`` are the documents the turn read or cited; those the
        caller can read become sources, so the SPACE audience check covers what
        the file was built from. The write reserves the artifact (GENERATING),
        uploads to a key no other upload uses, then records the revision.
        """
        await access.require("artifacts.create")
        name = output_name(file_name)
        if not data:
            raise ArtifactValidationError(f"produced file is empty: {name}")
        if len(data) > self.max_content_bytes:
            raise ArtifactValidationError(
                f"produced file exceeds the {self.max_content_bytes} byte limit: {name}"
            )
        content_type = _mime_type(mime_type, name)
        sources = await _readable_documents(access, source_ids)
        artifact_id, created = await self._reserve(access, conversation_id, name, content_type, sources)
        key = new_revision_object_key(access.workspace_id, artifact_id)
        try:
            await self.put_object(key, data, content_type)
        except BaseException:
            await self._release(access.workspace_id, artifact_id, failed=created)
            raise
        async with transaction_scope(self._sessions) as session:
            row = await load_artifact(session, access.workspace_id, artifact_id, for_update=True)
            assert row is not None
            item, artifact = row
            revision = await add_revision(
                session,
                item,
                artifact,
                storage_key=key,
                mime_type=content_type,
                size_bytes=len(data),
                author="assistant",
                creator_id=access.user_id,
                summary=" ".join(summary.split())[:500] or None,
            )
            target = artifact_name(access.workspace_id, item.id)
            await AuditService(session).record(
                workspace_id=access.workspace_id,
                actor=access.principal,
                category="files",
                action="CreateArtifact" if created else "ReviseArtifact",
                resource_type="artifact",
                target_name=target,
                details={"revision": revision.revision_number, "size_bytes": len(data)},
            )
            return GeneratedArtifact(
                artifact_id=item.id,
                name=target,
                display_name=item.title,
                file_name=name,
                mime_type=content_type,
                revision=revision.revision_number,
                size_bytes=len(data),
                update_time=artifact.updated_at,
            )

    async def _reserve(
        self,
        access: WorkspaceAccess,
        conversation_id: UUID | None,
        file_name: str,
        mime_type: str,
        sources: Sequence[UUID],
    ) -> tuple[UUID, bool]:
        """The artifact the file becomes a revision of, now GENERATING; ``True`` when new."""
        async with transaction_scope(self._sessions) as session:
            existing = (
                await _conversation_file(
                    session, access.workspace_id, access.user_id, conversation_id, file_name
                )
                if conversation_id is not None
                else None
            )
            if existing is None:
                item, _ = await create_artifact(
                    session,
                    workspace_id=access.workspace_id,
                    owner_id=access.user_id,
                    kind="file",
                    title=_title(file_name),
                    file_name=file_name,
                    mime_type=mime_type,
                    conversation_id=conversation_id,
                    source_ids=sources,
                )
                return item.id, True
            item, artifact = existing
            if item.status == "pending":
                raise ArtifactValidationError(
                    f"{file_name} is being written; try again when it is done"
                )
            await set_item(session, item, artifact, status="pending")
            await add_sources(session, artifact, sources)
            return item.id, False

    async def _release(self, workspace_id: UUID, artifact_id: UUID, *, failed: bool) -> None:
        """Undo a reservation whose upload failed: a new artifact FAILED, an old one ACTIVE."""
        async with transaction_scope(self._sessions) as session:
            row = await load_artifact(session, workspace_id, artifact_id, for_update=True)
            if row is not None:
                await set_item(session, row[0], row[1], status="failed" if failed else "ready")

    async def source_file(self, access: WorkspaceAccess, document_id: UUID) -> WorkspaceSource:
        """Read one document the caller may read, as bytes with its file name.

        Any readable document is a valid source, and reading one never changes
        it: the collection access check at read time is the whole authorization.
        """
        async with transaction_scope(self._sessions) as session:
            source = await require_visible_item(
                session,
                access.authorizer,
                access.principal,
                ItemRef(access.workspace_id, document_id),
            )
            if source.item_type != "document" or not source.storage_key:
                raise ArtifactValidationError("source is not an available document")
            title, storage_key = source.title, source.storage_key
            mime_type = source.mime_type or ARTIFACT_MIME_TYPE
            name = output_name(
                str(source.metadata_.get("file_name") or source.title), mime_type=mime_type
            )
        data = await self._object_storage().read(storage_key, max_bytes=_MAX_SOURCE_DOCUMENT_BYTES)
        return WorkspaceSource(
            document_id=str(document_id), title=title, file_name=name, mime_type=mime_type, data=data
        )


# -- Names and states -----------------------------------------------------------------


def artifact_name(workspace_id: UUID, artifact_id: UUID) -> str:
    return f"workspaces/{workspace_id}/artifacts/{artifact_id}"


def artifact_state(item: Item) -> str:
    """GENERATING, ACTIVE, FAILED or DELETED, from ``items.status`` and ``deleted_at``."""
    if item.deleted_at is not None:
        return "DELETED"
    return {"pending": "GENERATING", "failed": "FAILED"}.get(item.status, "ACTIVE")


def touch(artifact: Artifact) -> None:
    """Every artifact change moves ``updated_at``, the artifact etag."""
    artifact.updated_at = datetime.now(UTC)


# -- Rows (run in the caller's transaction) ---------------------------------------------


async def load_artifact(
    session: AsyncSession, workspace_id: UUID, artifact_id: UUID, *, for_update: bool = False
) -> tuple[Item, Artifact] | None:
    statement = (
        select(Item, Artifact)
        .join(Artifact, Artifact.item_id == Item.id)
        .where(Item.id == artifact_id, Item.tenant_id == workspace_id)
    )
    if for_update:
        statement = statement.with_for_update()
    row = (await session.execute(statement)).one_or_none()
    return (row[0], row[1]) if row is not None else None


async def create_artifact(
    session: AsyncSession,
    *,
    workspace_id: UUID,
    owner_id: UUID,
    kind: str,
    title: str,
    file_name: str,
    mime_type: str,
    conversation_id: UUID | None = None,
    space_id: UUID | None = None,
    audience: str = "private",
    evidence_review: Mapping[str, Any] | None = None,
    source_ids: Sequence[UUID] = (),
) -> tuple[Item, Artifact]:
    """The Item (GENERATING, no revision) in the owner's hidden collection and its facet."""
    item = await ItemService(session).create_artifact_item(
        workspace_id, owner_id, title=title, file_name=file_name, mime_type=mime_type
    )
    artifact = Artifact(
        item_id=item.id,
        kind=kind,
        owner_user_id=owner_id,
        conversation_id=conversation_id,
        space_id=space_id,
        audience=audience,
    )
    if evidence_review is not None:
        # Only set when present: an explicit None would store JSON null, not SQL NULL.
        artifact.evidence_review = dict(evidence_review)
    session.add(artifact)
    await session.flush()
    await add_sources(session, artifact, source_ids)
    return item, artifact


async def source_ids(session: AsyncSession, artifact_id: UUID) -> list[UUID]:
    return list(
        await session.scalars(
            select(ArtifactSourceItem.item_id)
            .where(ArtifactSourceItem.artifact_item_id == artifact_id)
            .order_by(ArtifactSourceItem.position)
        )
    )


async def add_sources(session: AsyncSession, artifact: Artifact, items: Sequence[UUID]) -> None:
    """Append the sources the artifact does not have yet, keeping their order."""
    existing = await source_ids(session, artifact.item_id)
    added = [value for value in dict.fromkeys(items) if value not in existing]
    for position, item_id in enumerate(added, start=len(existing)):
        session.add(
            ArtifactSourceItem(artifact_item_id=artifact.item_id, item_id=item_id, position=position)
        )
    await session.flush()


async def add_revision(
    session: AsyncSession,
    item: Item,
    artifact: Artifact,
    *,
    storage_key: str,
    mime_type: str,
    size_bytes: int,
    author: str,
    creator_id: UUID | None,
    summary: str | None,
    restored_from: int | None = None,
) -> ItemRevision:
    """Append a revision and make it current; the artifact becomes ACTIVE."""
    revision = await ItemService(session).append_revision(
        item,
        storage_key=storage_key,
        mime_type=mime_type,
        size_bytes=size_bytes,
        created_by_user_id=creator_id,
        restored_from=restored_from,
        summary=summary,
        author=author,
    )
    touch(artifact)
    await session.flush()
    return revision


async def delete_newest_revision(
    session: AsyncSession, item: Item, artifact: Artifact, number: int
) -> ItemRevision:
    """Tombstone the newest revision ``number``; returns the revision that is current now."""
    try:
        current = await ItemService(session).delete_newest_revision(item, number)
    except InvalidDocumentStateError as exc:
        raise ArtifactValidationError(str(exc)) from exc
    touch(artifact)
    await session.flush()
    return current


async def set_item(
    session: AsyncSession,
    item: Item,
    artifact: Artifact,
    *,
    status: str | None = None,
    title: str | None = None,
    deleted: bool | None = None,
) -> None:
    """Content status (GENERATING, ACTIVE, FAILED), title or tombstone of the artifact's Item."""
    await ItemService(session).set_item_state(item, status=status, title=title, deleted=deleted)
    touch(artifact)
    await session.flush()


async def live_revisions(
    session: AsyncSession, item_id: UUID, *, offset: int = 0, limit: int | None = None
) -> list[ItemRevision]:
    """Live revisions, newest first."""
    return await ItemService(session).live_revisions(item_id, offset=offset, limit=limit)


async def count_live_revisions(session: AsyncSession, item_id: UUID) -> int:
    return await ItemService(session).count_live_revisions(item_id)


async def current_revision(session: AsyncSession, item_id: UUID) -> ItemRevision | None:
    return await ItemService(session).current_revision(item_id)


async def live_revision(session: AsyncSession, item_id: UUID, number: int) -> ItemRevision | None:
    return await ItemService(session).revision(item_id, number)

# -- Evidence review matrix --------------------------------------------------------------


async def cells(session: AsyncSession, artifact_id: UUID) -> list[EvidenceReviewCell]:
    return list(
        await session.scalars(
            select(EvidenceReviewCell).where(EvidenceReviewCell.artifact_item_id == artifact_id)
        )
    )


def matrix_keys(artifact: Artifact) -> list[tuple[str, str]]:
    """Every (option, criterion) of the matrix, options first, in declared order."""
    review = artifact.evidence_review or {}
    return [
        (option["key"], criterion["key"])
        for option in review.get("options", [])
        for criterion in review.get("criteria", [])
    ]


async def reset_cells(
    session: AsyncSession, artifact: Artifact, keys: Iterable[tuple[str, str]]
) -> None:
    """Mark ``keys`` GENERATING (creating missing cells); cells outside the matrix are deleted."""
    wanted = set(matrix_keys(artifact))
    await drop_cells_outside(session, artifact)
    existing = {(cell.option_key, cell.criterion_key): cell for cell in await cells(session, artifact.item_id)}
    for key in keys:
        if key not in wanted:
            continue
        cell = existing.get(key)
        if cell is None:
            session.add(
                EvidenceReviewCell(
                    artifact_item_id=artifact.item_id, option_key=key[0], criterion_key=key[1]
                )
            )
        else:
            cell.state, cell.summary, cell.citations = "generating", None, []
    await session.flush()


async def drop_cells_outside(session: AsyncSession, artifact: Artifact) -> None:
    """Removing an option or criterion deletes its cells."""
    wanted = set(matrix_keys(artifact))
    for cell in await cells(session, artifact.item_id):
        if (cell.option_key, cell.criterion_key) not in wanted:
            await session.delete(cell)
    await session.flush()


def matrix_object(artifact: Artifact, rows: Sequence[EvidenceReviewCell]) -> bytes:
    """The frozen matrix one EVIDENCE_REVIEW revision stores."""
    by_key = {(cell.option_key, cell.criterion_key): cell for cell in rows}
    review = dict(artifact.evidence_review or {})
    review["cells"] = [
        {
            "option": option,
            "criterion": criterion,
            "state": by_key[(option, criterion)].state,
            "summary": by_key[(option, criterion)].summary,
            "citations": list(by_key[(option, criterion)].citations),
        }
        for option, criterion in matrix_keys(artifact)
        if (option, criterion) in by_key
    ]
    return json.dumps(review, ensure_ascii=False, sort_keys=True).encode()


async def restore_matrix(session: AsyncSession, artifact: Artifact, data: bytes) -> None:
    """Rewrite the matrix and its cells from a revision object (rollback, revision delete)."""
    document = json.loads(data)
    stored_cells = document.pop("cells", [])
    artifact.evidence_review = document
    touch(artifact)
    await session.execute(
        delete(EvidenceReviewCell).where(EvidenceReviewCell.artifact_item_id == artifact.item_id)
    )
    for cell in stored_cells:
        session.add(
            EvidenceReviewCell(
                artifact_item_id=artifact.item_id,
                option_key=cell["option"],
                criterion_key=cell["criterion"],
                state=cell["state"],
                summary=cell.get("summary"),
                citations=list(cell.get("citations") or []),
            )
        )
    await session.flush()


# -- Files ------------------------------------------------------------------------------


def output_name(value: str, *, mime_type: str | None = None) -> str:
    """A safe, bare file name that keeps the extension the format is keyed on.

    Path separators, traversal and control characters are stripped rather than
    rejected: the name comes from a model-driven sandbox, so it is data to make
    safe, not input to trust.
    """
    name = Path(value.strip()).name if value.strip() else ""
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")[:120]
    if not Path(name).suffix:
        wanted = (mime_type or "").split(";", 1)[0].strip().casefold()
        extension = next(
            (suffix for suffix, candidate in _MIME_TYPES.items() if candidate == wanted), ""
        )
        name = f"{name or _DEFAULT_OUTPUT_NAME}{extension}"
    return name or _DEFAULT_OUTPUT_NAME


def revision_document(item: Item, revision: ItemRevision) -> Item:
    """A transient document Item whose original is one artifact revision.

    Never added to a session; it lets the parse and preview services, which
    read an Item's original, read a revision's.
    """
    return Item(
        id=item.id,
        tenant_id=item.tenant_id,
        parent_item_id=item.parent_item_id,
        item_type="document",
        title=item.title,
        mime_type=revision.mime_type,
        size_bytes=revision.size_bytes,
        storage_key=revision.storage_key,
        metadata_={
            "file_name": stored_file_name(item),
            "preview": revision.exports.get("preview"),
        },
    )


def stored_file_name(item: Item) -> str:
    value = item.metadata_.get("file_name")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return output_name(item.title, mime_type=item.mime_type)


def _mime_type(value: str | None, file_name: str) -> str:
    """The sandbox's reported type wins; when missing or generic, the extension decides."""
    reported = (value or "").split(";", 1)[0].strip().casefold()
    if reported and reported != _DEFAULT_MIME_TYPE:
        return reported
    return _MIME_TYPES.get(Path(file_name).suffix.casefold(), _DEFAULT_MIME_TYPE)


def _title(value: str) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise ArtifactValidationError("document title must not be blank")
    return normalized[:MAX_TITLE_LENGTH]


async def _conversation_file(
    session: AsyncSession,
    workspace_id: UUID,
    owner_id: UUID,
    conversation_id: UUID,
    file_name: str,
) -> tuple[Item, Artifact] | None:
    """The live FILE artifact a conversation already keeps under one file name."""
    row = (
        await session.execute(
            select(Item, Artifact)
            .join(Artifact, Artifact.item_id == Item.id)
            .where(
                Item.tenant_id == workspace_id,
                Item.deleted_at.is_(None),
                Item.metadata_["file_name"].astext == file_name,
                Artifact.owner_user_id == owner_id,
                Artifact.conversation_id == conversation_id,
                Artifact.kind == "file",
            )
            .order_by(Item.created_at)
            .limit(1)
            .with_for_update()
        )
    ).one_or_none()
    return (row[0], row[1]) if row is not None else None


async def _readable_documents(access: WorkspaceAccess, item_ids: Sequence[UUID]) -> list[UUID]:
    """The DOCUMENT items of ``item_ids`` the caller can read now (no reviewer exception);
    the hidden artifacts collection never supplies sources."""
    readable: list[UUID] = []
    for item_id in dict.fromkeys(item_ids):
        path = await access.authorizer.ancestry(item_id)
        if (
            path
            and path[0].item_type == "document"
            and not any(node.system_kind in HIDDEN_KINDS for node in path)
            and await is_visible(
                access.authorizer, access.principal, ItemRef(access.workspace_id, item_id)
            )
        ):
            readable.append(item_id)
    return readable


__all__ = [
    "EVIDENCE_REVIEW_MIME_TYPE",
    "MAX_TITLE_LENGTH",
    "ArtifactService",
    "GeneratedArtifact",
    "RevisionPreview",
    "WorkspaceSource",
    "add_revision",
    "add_sources",
    "artifact_name",
    "artifact_state",
    "cells",
    "count_live_revisions",
    "create_artifact",
    "current_revision",
    "delete_newest_revision",
    "drop_cells_outside",
    "live_revision",
    "live_revisions",
    "load_artifact",
    "matrix_keys",
    "matrix_object",
    "new_revision_object_key",
    "output_name",
    "reset_cells",
    "restore_matrix",
    "revision_document",
    "set_item",
    "source_ids",
    "stored_file_name",
    "touch",
]
