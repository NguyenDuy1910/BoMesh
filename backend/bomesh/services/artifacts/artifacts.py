"""The Artifact resource: create and revise (operations), read, update, lifecycle, commit,
export and publish (``api_design.md`` §7)."""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Artifact, Item, Operation
from bomesh.errors import (
    AlreadyExists,
    FailedPrecondition,
    InvalidArgument,
    NotFound,
    PermissionDenied,
)
from bomesh.iam.authorizer import ItemRef, Principal, WorkspaceRef, permission_denied
from bomesh.services.artifacts.artifact_store import (
    EVIDENCE_REVIEW_MIME_TYPE,
    MAX_TITLE_LENGTH,
    add_revision,
    artifact_name,
    cells,
    create_artifact,
    current_revision,
    drop_cells_outside,
    live_revision,
    matrix_keys,
    new_revision_object_key,
    reset_cells,
    set_item,
    source_ids,
    stored_file_name,
    touch,
)
from bomesh.services.artifacts.generation import ArtifactGenerator, restore_unfinished
from bomesh.services.artifacts.records import (
    ArtifactRecord,
    ArtifactUpdate,
    Download,
    NewArtifact,
    ReviewEntry,
    Revise,
)
from bomesh.services.artifacts.rendering import (
    MARKDOWN,
    ExportSource,
    export_file_name,
    render,
    review_markdown,
)
from bomesh.services.artifacts.support import (
    UNAVAILABLE_TEXT,
    ArtifactDeps,
    artifact_record,
    cell_rows,
    is_text,
    member_space,
    open_artifact,
    render_review,
    require_audience_reads,
    require_etag,
    require_space_reads,
    require_state,
    review_json,
    revision_review,
    withheld,
)
from bomesh.services.collaboration.membership import member_space_ids
from bomesh.services.conversations.references import own_conversation_id
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.operations import (
    OPERATION_HANDLERS,
    Operations,
    operation_name,
)
from bomesh.services.kernel.retention import require_restorable
from bomesh.services.kernel.workspaces import require_module
from bomesh.services.knowledge_items.items import KnowledgeItemService, create_document
from bomesh.services.knowledge_items.records import UploadedFile
from bomesh.services.knowledge_items.summary import get_item_summary
from bomesh.services.workspaces.members import active_member_ids

MAX_SOURCES = 50
MAX_MATRIX_SIDE = 20
_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DEFAULT_TITLES = {
    "FILE": "Document",
    "DRAFT": "Draft",
    "EVIDENCE_REVIEW": "Evidence review",
    "STUDY_GUIDE": "Study guide",
    "QUIZ": "Quiz",
}
_MUTABLE = frozenset(
    {"displayName", "audience", "space", "evidenceReview.options", "evidenceReview.criteria"}
)

#: ``Artifact.state`` as SQL, for filters.
STATE = case(
    (Item.deleted_at.is_not(None), "DELETED"),
    (Item.status == "pending", "GENERATING"),
    (Item.status == "failed", "FAILED"),
    else_="ACTIVE",
)
KIND = func.upper(Artifact.kind)


class ArtifactResourceService:
    """One canonical service for ``workspaces/{w}/artifacts``."""

    def __init__(self, deps: ArtifactDeps) -> None:
        self._deps = deps
        self._generator = ArtifactGenerator(deps)

    @classmethod
    def from_runtime(cls, runtime: Any) -> ArtifactResourceService:
        return cls(ArtifactDeps.from_runtime(runtime))

    # -- Create and revise (operations) ---------------------------------------------------

    async def create(
        self, ctx: RequestContext, workspace_id: UUID, spec: NewArtifact, *, request_id: UUID | None
    ) -> Operation:
        """CreateArtifact: the artifact exists at once (GENERATING); the operation finishes it."""
        workspace = await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "artifacts.create", write=True
        )
        if spec.kind != "FILE":
            require_module(workspace, "work")
        _validate_new(spec)
        parent = f"workspaces/{workspace_id}"
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateArtifact",
                    parent=parent,
                    request=spec.fingerprint(),
                )
                if (replayed := await idempotency.replay(key)) is not None:
                    return await _own_operation(session, ctx, replayed)
            sources = await self._sources(session, ctx, workspace_id, spec.source_items)
            space_id = (
                await member_space(session, ctx, workspace_id, spec.space, permission="artifacts.create")
                if spec.space
                else None
            )
            if spec.audience == "SPACE":
                if space_id is None:
                    raise InvalidArgument.for_field("space", "A SPACE audience needs a space.")
                await require_space_reads(session, ctx, workspace_id, space_id, sources)
            conversation_id = None
            if spec.conversation:
                conversation_id = await own_conversation_id(
                    session, workspace_id, ctx.user_id, spec.conversation
                )
                if conversation_id is None:
                    raise PermissionDenied(
                        "Permission 'artifacts.create' denied on resource "
                        f"'{parent}/conversations/{spec.conversation}' (or it might not exist)."
                    )
            review = (
                {"options": review_json(spec.options), "criteria": review_json(spec.criteria)}
                if spec.kind == "EVIDENCE_REVIEW"
                else None
            )
            title = (spec.display_name or "").strip() or _DEFAULT_TITLES[spec.kind]
            item, artifact = await create_artifact(
                session,
                workspace_id=workspace_id,
                owner_id=ctx.user_id,
                kind=spec.kind.lower(),
                title=title,
                file_name=f"{title}.json" if review is not None else f"{title}.md",
                mime_type=EVIDENCE_REVIEW_MIME_TYPE if review is not None else MARKDOWN,
                conversation_id=conversation_id,
                space_id=space_id,
                audience=spec.audience.lower(),
                evidence_review=review,
                source_ids=sources,
            )
            if review is not None:
                await reset_cells(session, artifact, matrix_keys(artifact))
            name = artifact_name(workspace_id, item.id)
            operation = await Operations(session).create(
                ctx.principal, verb="createArtifact", target=name, workspace_id=workspace_id
            )
            await Audit(session).record(
                ctx, workspace_id=workspace_id, category="files", action="CreateArtifact", target=name
            )
            if key is not None:
                await idempotency.remember(key, operation_name(operation.id))
        self._deps.engine.start(
            operation.id,
            self._generator.run(
                operation.id,
                workspace_id,
                item.id,
                instructions=spec.instructions,
                cell_keys=None,
                creating=True,
            ),
        )
        return operation

    async def revise(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        request: Revise,
        *,
        etag: str | None,
    ) -> Operation:
        """ReviseArtifact: a new assistant revision, or the named cells regenerated."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "artifacts.revise", write=True
        )
        instructions = (request.instructions or "").strip() or None
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.revise", owner_only=True, for_update=True
            )
            require_etag(workspace_id, artifact, etag)
            require_state(item, allowed=("ACTIVE",), action="revised")
            keys: list[tuple[str, str]] | None = None
            if artifact.kind == "evidence_review":
                matrix = matrix_keys(artifact)
                keys = [(cell.option, cell.criterion) for cell in request.cells] or matrix
                unknown = [key for key in keys if key not in matrix]
                if unknown:
                    raise InvalidArgument.for_field(
                        "cells", f"{unknown[0][0]} × {unknown[0][1]} is not a cell of this review."
                    )
                await reset_cells(session, artifact, keys)
            else:
                if request.cells:
                    raise InvalidArgument.for_field("cells", "Only an EVIDENCE_REVIEW has cells.")
                if not is_text(artifact, item):
                    raise FailedPrecondition("Only text artifacts can be revised by the assistant.")
                if instructions is None:
                    raise InvalidArgument.for_field("instructions", "instructions are required.")
            await set_item(session, item, artifact, status="pending")
            name = artifact_name(workspace_id, artifact_id)
            operation = await Operations(session).create(
                ctx.principal, verb="reviseArtifact", target=name, workspace_id=workspace_id
            )
            await Audit(session).record(
                ctx, workspace_id=workspace_id, category="files", action="ReviseArtifact", target=name
            )
        self._deps.engine.start(
            operation.id,
            self._generator.run(
                operation.id,
                workspace_id,
                artifact_id,
                instructions=instructions,
                cell_keys=keys,
                creating=False,
            ),
        )
        return operation

    async def _sources(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, items: Sequence[UUID]
    ) -> list[UUID]:
        """The source documents, each readable by the caller (no reviewer exception)."""
        resolved: list[UUID] = []
        for item_id in dict.fromkeys(items):
            summary = await get_item_summary(session, ctx.authorizer, ctx.principal, workspace_id, item_id)
            if summary is None:
                raise permission_denied("items.get", ItemRef(workspace_id, item_id))
            if summary.item_type != "DOCUMENT":
                raise InvalidArgument.for_field("sourceItems", "Every source item must be a DOCUMENT.")
            if summary.item_id not in resolved:
                resolved.append(summary.item_id)
        return resolved

    # -- Reads -------------------------------------------------------------------------------

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, *, full: bool = True
    ) -> ArtifactRecord:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.get", owner_only=False
            )
            return await artifact_record(session, ctx, workspace_id, item, artifact, full=full)

    async def media(self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID) -> Download:
        """GetArtifact ``alt=media``: the current revision as stored, unless it holds unreadable content."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.get", owner_only=False
            )
            current = await current_revision(session, artifact_id)
        if current is None:
            raise FailedPrecondition("The artifact has no content yet.")
        data = await self._deps.engine.read_object(current.storage_key)
        async with transaction_scope(self._deps.sessions) as session:
            review = (
                await revision_review(session, ctx, workspace_id, artifact, data)
                if artifact.kind == "evidence_review"
                else None
            )
            hidden = await withheld(session, ctx, workspace_id, artifact, review)
        if hidden:
            raise PermissionDenied("The artifact contains content from sources you cannot read now.")
        return Download(data=data, mime_type=current.mime_type, file_name=stored_file_name(item))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery, *, full: bool
    ) -> tuple[list[ArtifactRecord], int]:
        """Own artifacts plus SPACE-audience artifacts of the caller's spaces."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.list", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            spaces = await member_space_ids(session, workspace_id, ctx.user_id)
            own = Artifact.owner_user_id == ctx.user_id
            shared = and_(
                Artifact.audience == "space",
                Artifact.space_id.in_(spaces) if spaces else False,
                Item.deleted_at.is_(None),
            )
            statement = (
                select(Item, Artifact)
                .join(Artifact, Artifact.item_id == Item.id)
                .where(Item.tenant_id == workspace_id, or_(own, shared))
            )
            if not query.show_deleted:
                statement = statement.where(Item.deleted_at.is_(None))
            rows = (await session.execute(query.apply(statement))).all()
            total = await session.scalar(query.count(statement))
            records = [
                await artifact_record(session, ctx, workspace_id, item, artifact, full=full)
                for item, artifact in rows
            ]
        return records, int(total or 0)

    # -- Update and lifecycle -------------------------------------------------------------------

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        change: ArtifactUpdate,
        *,
        etag: str | None,
    ) -> ArtifactRecord:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.update", write=True)
        unknown = change.paths - _MUTABLE
        if unknown:
            raise InvalidArgument.for_field("updateMask", f"'{sorted(unknown)[0]}' cannot be updated.")
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.update", owner_only=True, for_update=True
            )
            require_etag(workspace_id, artifact, etag)
            require_state(item, allowed=("ACTIVE", "GENERATING", "FAILED"), action="updated")
            if "displayName" in change.paths:
                await set_item(session, item, artifact, title=_display_name(change.display_name))
            if "space" in change.paths:
                artifact.space_id = (
                    await member_space(session, ctx, workspace_id, change.space, permission="artifacts.update")
                    if change.space
                    else None
                )
            if "audience" in change.paths:
                if change.audience is None:
                    raise InvalidArgument.for_field("audience", "audience is required.")
                artifact.audience = change.audience.lower()
            review_paths = {"evidenceReview.options", "evidenceReview.criteria"} & change.paths
            if review_paths:
                await self._update_matrix(session, item, artifact, change, review_paths)
            if artifact.audience == "space":
                if artifact.space_id is None:
                    raise InvalidArgument.for_field("space", "A SPACE audience needs a space.")
                await require_space_reads(
                    session, ctx, workspace_id, artifact.space_id, await source_ids(session, artifact_id)
                )
            touch(artifact)
            await session.flush()
            await self._audit(session, ctx, workspace_id, artifact_id, "UpdateArtifact")
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    async def _update_matrix(
        self,
        session: AsyncSession,
        item: Item,
        artifact: Artifact,
        change: ArtifactUpdate,
        paths: set[str],
    ) -> None:
        if artifact.kind != "evidence_review":
            raise InvalidArgument.for_field(
                sorted(paths)[0], "Only an EVIDENCE_REVIEW has options and criteria."
            )
        require_state(item, allowed=("ACTIVE", "FAILED"), action="changed while generating")
        review = dict(artifact.evidence_review or {})
        if "evidenceReview.options" in paths:
            _validate_entries(change.options, "evidenceReview.options")
            review["options"] = review_json(change.options)
        if "evidenceReview.criteria" in paths:
            _validate_entries(change.criteria, "evidenceReview.criteria")
            review["criteria"] = review_json(change.criteria)
        artifact.evidence_review = review
        await drop_cells_outside(session, artifact)

    async def delete(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, *, etag: str | None
    ) -> ArtifactRecord:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.delete", owner_only=True, for_update=True
            )
            require_etag(workspace_id, artifact, etag)
            if item.deleted_at is not None:
                raise FailedPrecondition("The artifact is already deleted.")
            await set_item(session, item, artifact, deleted=True)
            await self._audit(session, ctx, workspace_id, artifact_id, "DeleteArtifact")
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    async def undelete(
        self, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, *, etag: str | None
    ) -> ArtifactRecord:
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.undelete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.undelete", owner_only=True, for_update=True
            )
            require_etag(workspace_id, artifact, etag)
            if item.deleted_at is None:
                raise AlreadyExists(f"'{artifact_name(workspace_id, artifact_id)}' is not deleted.")
            require_restorable(item.deleted_at, artifact_name(workspace_id, artifact_id))
            await set_item(session, item, artifact, deleted=False)
            await self._audit(session, ctx, workspace_id, artifact_id, "UndeleteArtifact")
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    # -- Commit, export, publish ------------------------------------------------------------------

    async def commit(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        *,
        text: str,
        change_summary: str | None,
        etag: str | None,
    ) -> ArtifactRecord:
        """CommitArtifact: a person's edit of a text artifact becomes a USER revision."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.commit", write=True)
        data = text.encode()
        if len(data) > self._deps.engine.max_content_bytes:
            raise InvalidArgument.for_field("text", "The text exceeds the artifact size limit.")
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await self._editable(session, ctx, workspace_id, artifact_id, etag)
            mime_type = item.mime_type or MARKDOWN
        # A key no other upload uses: a concurrent edit can never overwrite these bytes.
        key = new_revision_object_key(workspace_id, artifact_id)
        await self._deps.engine.put_object(key, data, mime_type)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await self._editable(session, ctx, workspace_id, artifact_id, etag)
            await add_revision(
                session,
                item,
                artifact,
                storage_key=key,
                mime_type=mime_type,
                size_bytes=len(data),
                author="user",
                creator_id=ctx.user_id,
                summary=(change_summary or "").strip()[:500] or None,
            )
            await self._audit(session, ctx, workspace_id, artifact_id, "CommitArtifact")
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    async def _editable(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        etag: str | None,
    ) -> tuple[Item, Artifact]:
        item, artifact = await open_artifact(
            session, ctx, workspace_id, artifact_id, "artifacts.commit", owner_only=True, for_update=True
        )
        require_etag(workspace_id, artifact, etag)
        require_state(item, allowed=("ACTIVE",), action="edited")
        if not is_text(artifact, item):
            raise FailedPrecondition("Only text artifacts accept an edit.")
        return item, artifact

    async def export(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        *,
        mime_type: str,
        revision: int | None,
    ) -> Download:
        """ExportArtifact: a revision rendered for the caller; never creates anything."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.export", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.export", owner_only=False
            )
            stored = (
                await live_revision(session, item.id, revision)
                if revision is not None
                else await current_revision(session, item.id)
            )
        if stored is None:
            if revision is not None:
                raise NotFound(
                    f"Resource '{artifact_name(workspace_id, item.id)}/revisions/{revision}' "
                    "was not found."
                )
            raise FailedPrecondition("The artifact has no content yet.")
        data = await self._deps.engine.read_object(stored.storage_key)
        async with transaction_scope(self._deps.sessions) as session:
            source = await self._export_source(
                session, ctx, workspace_id, item, artifact, stored.mime_type, data
            )
        return Download(
            data=render(source, mime_type),
            mime_type=mime_type,
            file_name=export_file_name(stored_file_name(item), mime_type),
        )

    async def _export_source(
        self,
        session: AsyncSession,
        ctx: RequestContext,
        workspace_id: UUID,
        item: Item,
        artifact: Artifact,
        mime_type: str,
        data: bytes,
    ) -> ExportSource:
        if artifact.kind == "evidence_review":
            return ExportSource(
                title=item.title,
                mime_type=mime_type,
                review=await revision_review(session, ctx, workspace_id, artifact, data),
            )
        hidden = await withheld(session, ctx, workspace_id, artifact, None)
        if mime_type.startswith("text/"):
            return ExportSource(
                title=item.title,
                mime_type=mime_type,
                text=UNAVAILABLE_TEXT if hidden else data.decode("utf-8", errors="replace"),
            )
        if hidden:
            raise PermissionDenied("The artifact contains content from sources you cannot read now.")
        return ExportSource(title=item.title, mime_type=mime_type, data=data)

    async def publish(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        artifact_id: UUID,
        collection_id: UUID,
        *,
        etag: str | None,
        request_id: UUID | None,
    ) -> str:
        """PublishArtifact: a new PUBLISHED document in ``collection``; returns its item name."""
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "artifacts.publish", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.publish", owner_only=True
            )
            require_etag(workspace_id, artifact, etag)
            require_state(item, allowed=("ACTIVE",), action="published")
            collection = await get_item_summary(
                session, ctx.authorizer, ctx.principal, workspace_id, collection_id
            )
            if collection is None:
                raise permission_denied("items.create", ItemRef(workspace_id, collection_id))
            if collection.item_type != "COLLECTION":
                raise InvalidArgument.for_field("collection", "collection must be a COLLECTION.")
            sources = await source_ids(session, artifact_id)
            readers = [
                user_id
                for user_id in await active_member_ids(session, workspace_id)
                if "items.get"
                in await ctx.authorizer.collection_permissions(Principal(user_id), collection.item_id)
            ]
            await require_audience_reads(session, ctx, workspace_id, readers, sources)
            current = await current_revision(session, artifact_id)
            assert current is not None
            markdown = (
                await self._review_markdown(session, ctx, workspace_id, item, artifact)
                if artifact.kind == "evidence_review"
                else None
            )
        name = stored_file_name(item)
        file = (
            UploadedFile(
                data=markdown.encode(),
                file_name=export_file_name(name, MARKDOWN),
                content_type=MARKDOWN,
            )
            if markdown is not None
            else UploadedFile(
                data=await self._deps.engine.read_object(current.storage_key),
                file_name=name,
                content_type=current.mime_type,
            )
        )
        record = await create_document(
            KnowledgeItemService.from_runtime(self._deps.runtime),
            ctx,
            workspace_id,
            collection.item_id,
            file,
            display_name=item.title,
            request_id=request_id,
        )
        async with transaction_scope(self._deps.sessions) as session:
            await self._audit(session, ctx, workspace_id, artifact_id, "PublishArtifact")
        return f"workspaces/{workspace_id}/items/{record.item_id}"

    async def _review_markdown(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item: Item, artifact: Artifact
    ) -> str:
        review = await render_review(
            session,
            ctx,
            workspace_id,
            artifact.evidence_review or {},
            cell_rows(artifact, await cells(session, item.id)),
        )
        return review_markdown(item.title, review)

    async def _audit(
        self, session: AsyncSession, ctx: RequestContext, workspace_id: UUID, artifact_id: UUID, action: str
    ) -> None:
        await Audit(session).record(
            ctx,
            workspace_id=workspace_id,
            category="files",
            action=action,
            target=artifact_name(workspace_id, artifact_id),
        )

    # -- Operation results --------------------------------------------------------------------

    async def result(self, workspace_id: UUID, artifact_id: UUID) -> ArtifactRecord:
        """The finished operation's artifact, as its owner sees it (operations are own-only)."""
        async with transaction_scope(self._deps.sessions) as session:
            row = await session.get(Artifact, artifact_id)
            if row is None:
                raise NotFound(f"Resource '{artifact_name(workspace_id, artifact_id)}' was not found.")
            owner = row.owner_user_id
        ctx = RequestContext(
            principal=Principal(owner), authorizer=self._deps.runtime.authorizer_factory()
        )
        async with transaction_scope(self._deps.sessions) as session:
            item, artifact = await open_artifact(
                session, ctx, workspace_id, artifact_id, "artifacts.get", owner_only=True
            )
            return await artifact_record(session, ctx, workspace_id, item, artifact)

    async def stop(self, operation: Operation) -> None:
        """Cancel hook: stop the running work; it reverts the artifact's state itself."""
        self._deps.engine.cancel(operation.id)

    async def abandon(self, operation: Operation) -> None:
        """Abandon hook: the operation was failed while nothing runs it any more (a crash);
        put the artifact back as if its generation had failed."""
        _, workspace, _, artifact = operation.target.split("/")
        async with transaction_scope(self._deps.sessions) as session:
            await restore_unfinished(
                session,
                UUID(workspace),
                UUID(artifact),
                creating=operation.verb == "createArtifact",
            )


async def load_result(runtime: Any, result_name: str) -> ArtifactRecord:
    _, workspace, _, artifact = result_name.split("/")
    return await ArtifactResourceService.from_runtime(runtime).result(UUID(workspace), UUID(artifact))


async def stop_generation(runtime: Any, operation: Operation) -> None:
    await ArtifactResourceService.from_runtime(runtime).stop(operation)


async def abandon_generation(runtime: Any, operation: Operation) -> None:
    await ArtifactResourceService.from_runtime(runtime).abandon(operation)



async def _own_operation(session: AsyncSession, ctx: RequestContext, name: str) -> Operation:
    operation = await session.get(Operation, UUID(name.removeprefix("operations/")))
    if operation is None or operation.user_id != ctx.user_id:
        raise NotFound(f"Resource '{name}' was not found.")
    return operation


def _display_name(value: str | None) -> str:
    name = (value or "").strip()
    if not name:
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    if len(name) > MAX_TITLE_LENGTH:
        raise InvalidArgument.for_field("displayName", f"displayName exceeds {MAX_TITLE_LENGTH} characters.")
    return name


def _validate_new(spec: NewArtifact) -> None:
    if spec.display_name is not None and spec.display_name.strip():
        _display_name(spec.display_name)
    if len(spec.source_items) > MAX_SOURCES:
        raise InvalidArgument.for_field("sourceItems", f"At most {MAX_SOURCES} source items.")
    if spec.kind == "EVIDENCE_REVIEW":
        _validate_entries(spec.options, "evidenceReview.options")
        _validate_entries(spec.criteria, "evidenceReview.criteria")
    elif spec.has_evidence_review:
        raise InvalidArgument.for_field("evidenceReview", "Only an EVIDENCE_REVIEW has one.")
    elif not spec.source_items and not (spec.instructions or "").strip():
        raise InvalidArgument.for_field(
            "generationInstructions", "Give generationInstructions or sourceItems."
        )


def _validate_entries(entries: Sequence[ReviewEntry], field: str) -> None:
    if not entries:
        raise InvalidArgument.for_field(field, f"{field} needs at least one entry.")
    if len(entries) > MAX_MATRIX_SIDE:
        raise InvalidArgument.for_field(field, f"{field} has at most {MAX_MATRIX_SIDE} entries.")
    keys = [entry.key for entry in entries]
    if len(set(keys)) != len(keys):
        raise InvalidArgument.for_field(field, f"{field} keys must be unique.")
    if not all(_KEY.match(key) for key in keys):
        raise InvalidArgument.for_field(field, "A key is 1-64 letters, digits, '_' or '-'.")


# Registered on import: the operation hooks exist whenever the service does.
for _verb in ("createArtifact", "reviseArtifact"):
    OPERATION_HANDLERS.register_result(_verb, load_result)
    OPERATION_HANDLERS.register_cancel(_verb, stop_generation)
    OPERATION_HANDLERS.register_abandon(_verb, abandon_generation)


__all__ = ["KIND", "STATE", "ArtifactResourceService"]
