"""Artifact revisions: list, get (with the viewer preview), delete the newest user edit, rollback."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Artifact, Item, ItemRevision
from bomesh.errors import FailedPrecondition, NotFound
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.artifacts.artifact_store import (
    add_revision,
    artifact_name,
    count_live_revisions,
    current_revision,
    delete_newest_revision,
    live_revision,
    live_revisions,
    restore_matrix,
)
from bomesh.services.artifacts.records import ArtifactRecord, RevisionRecord
from bomesh.services.artifacts.support import (
    ArtifactDeps,
    artifact_record,
    open_artifact,
    require_etag,
    require_state,
    snapshot_record,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext

#: How long the newest USER revision may still be deleted.
DELETE_WINDOW = timedelta(minutes=10)


class ArtifactRevisionService:
    """``workspaces/{w}/artifacts/{a}/revisions``: owner only."""

    def __init__(self, deps: ArtifactDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ArtifactRevisionService:
        return cls(ArtifactDeps.from_runtime(runtime))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, *, offset: int, limit: int
    ) -> tuple[list[RevisionRecord], int]:
        """Newest first; only the current revision carries its viewer preview."""
        await self._open(ctx, workspace_id, "artifactRevisions.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifactRevisions.list", owner_only=True
            )
            current = await current_revision(session, artifact_id)
            rows = await live_revisions(session, artifact_id, offset=offset, limit=limit)
            total = await count_live_revisions(session, artifact_id)
        records = [
            await self._record(
                ctx,
                workspace_id,
                item,
                artifact,
                row,
                preview=current is not None and row.id == current.id,
            )
            for row in rows
        ]
        return records, total

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, number: int
    ) -> RevisionRecord:
        await self._open(ctx, workspace_id, "artifactRevisions.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifactRevisions.get", owner_only=True
            )
            revision = await self._revision(session, workspace_id, artifact_id, number)
        return await self._record(ctx, workspace_id, item, artifact, revision, preview=True)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, number: int
    ) -> None:
        """Only the newest USER revision, within ten minutes of its creation."""
        await self._open(ctx, workspace_id, "artifactRevisions.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session,
                ctx,
                workspace_id,
                artifact_id,
                "artifactRevisions.delete",
                owner_only=True,
                for_update=True,
            )
            require_state(item, allowed=("ACTIVE",), action="changed")
            revision = await self._revision(session, workspace_id, artifact_id, number)
            newest = await live_revisions(session, artifact_id, limit=2)
            if (
                newest[0].id != revision.id
                or revision.author != "user"
                or len(newest) < 2
                or datetime.now(UTC) - revision.created_at > DELETE_WINDOW
            ):
                raise FailedPrecondition(
                    "Only the newest user revision can be deleted, within 10 minutes."
                )
            current = await delete_newest_revision(session, item, artifact, number)
            await self._restore_matrix(session, artifact, current)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="files",
                action="DeleteArtifactRevision",
                target=_name(workspace_id, artifact_id, number),
            )

    async def rollback(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        number: int,
        *,
        etag: str | None,
    ) -> ArtifactRecord:
        """A new USER revision reusing the given revision's object (no copy)."""
        await self._open(ctx, workspace_id, "artifactRevisions.rollback", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session,
                ctx,
                workspace_id,
                artifact_id,
                "artifactRevisions.rollback",
                owner_only=True,
                for_update=True,
            )
            require_etag(workspace_id, artifact, etag)
            require_state(item, allowed=("ACTIVE",), action="rolled back")
            source = await self._revision(session, workspace_id, artifact_id, number)
            restored = await add_revision(
                session,
                item,
                artifact,
                storage_key=source.storage_key,
                mime_type=source.mime_type,
                size_bytes=source.size_bytes,
                author="user",
                creator_id=ctx.user_id,
                summary=f"Restored revision {number}.",
                restored_from=number,
            )
            await self._restore_matrix(session, artifact, restored)
            await Audit(session).record(
                ctx,
                workspace_id=workspace_id,
                category="files",
                action="RollbackArtifact",
                target=_name(workspace_id, artifact_id, number),
            )
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    async def _restore_matrix(
        self, session: AsyncSession, artifact: Artifact, revision: ItemRevision
    ) -> None:
        """The current revision changed: a matrix is rewritten from its object."""
        if artifact.kind == "evidence_review":
            await restore_matrix(
                session, artifact, await self._deps.engine.read_object(revision.storage_key)
            )

    async def _open(self, ctx: RequestContext, workspace_id: UUID, permission: str, *, write: bool) -> None:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), permission, write=write)

    async def _revision(
        self, session: AsyncSession, workspace_id: UUID, artifact_id: UUID, number: int
    ) -> ItemRevision:
        revision = await live_revision(session, artifact_id, number)
        if revision is None:
            raise NotFound(f"Resource '{_name(workspace_id, artifact_id, number)}' was not found.")
        return revision

    async def _record(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        item: Item,
        artifact: Artifact,
        revision: ItemRevision,
        *,
        preview: bool,
    ) -> RevisionRecord:
        snapshot = await snapshot_record(
            self._deps, ctx, workspace_id, item, artifact, revision, preview=preview
        )
        return RevisionRecord(
            workspace_id=workspace_id,
            artifact_id=artifact.item_id,
            number=revision.revision_number,
            snapshot=snapshot,
            author="USER" if revision.author == "user" else "ASSISTANT",
            creator_id=revision.created_by_user_id if revision.author == "user" else None,
            change_summary=revision.summary,
            create_time=revision.created_at,
        )


def _name(workspace_id: UUID, artifact_id: UUID, number: int) -> str:
    return f"{artifact_name(workspace_id, artifact_id)}/revisions/{number}"


__all__ = ["DELETE_WINDOW", "ArtifactRevisionService"]
