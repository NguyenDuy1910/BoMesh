"""Shared parts of the artifact services: dependencies, access, per-reader records, audience.

Access (``api_design.md`` §7): the owner may do everything; while the
audience is SPACE, live members of the artifact's space may also read it (Get,
List, Export). Anyone else gets NOT_FOUND (the workspace permission was
already checked), a space reader calling an owner-only method PERMISSION_DENIED.
Readability of sources and citations is re-checked on every read.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import Artifact, EvidenceReviewCell, Item, ItemRevision
from bomesh.errors import FailedPrecondition, NotFound, PermissionDenied
from bomesh.services.artifacts.artifact_store import (
    ArtifactService,
    artifact_name,
    artifact_state,
    cells,
    current_revision,
    load_artifact,
    matrix_keys,
    source_ids,
)
from bomesh.services.artifacts.records import (
    ArtifactRecord,
    CellRecord,
    EvidenceReviewRecord,
    ReviewEntry,
    SnapshotRecord,
)
from bomesh.services.collaboration.membership import (
    is_space_member,
    space_codes,
    space_id_for_code,
    space_member_ids,
)
from bomesh.services.conversations.citations import (
    readable_summaries,
    render_citations,
    unreadable_items,
)
from bomesh.services.conversations.records import StoredCitation
from bomesh.services.conversations.references import conversation_codes
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.retention import is_purged, purge_time
from bomesh.services.kernel.workspaces import WorkspaceResolver
from bomesh.services.knowledge_items.content import (
    resolve_page_assets,
    resolve_rendition,
)
from bomesh.services.knowledge_items.records import PageAsset
from bomesh.services.knowledge_items.summary import ItemSummary

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

AUDIENCE_CANNOT_READ_SOURCES = "AUDIENCE_CANNOT_READ_SOURCES"
UNAVAILABLE_TEXT = "[Unavailable: this part cites sources you cannot open now.]"
TEXT_KINDS = frozenset({"draft", "study_guide", "quiz"})


@dataclass(frozen=True, slots=True)
class ArtifactDeps:
    runtime: AppRuntime
    sessions: SessionFactory
    engine: ArtifactService
    workspaces: WorkspaceResolver
    request_hash_secret: bytes

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ArtifactDeps:
        sessions = runtime.sessions()
        return cls(
            runtime=runtime,
            sessions=sessions,
            engine=runtime.artifact_service(),
            workspaces=WorkspaceResolver(sessions),
            request_hash_secret=runtime.request_hash_secret(),
        )


def revision_name(workspace_id: UUID, artifact_id: UUID, number: int) -> str:
    return f"{artifact_name(workspace_id, artifact_id)}/revisions/{number}"


def etag_of(workspace_id: UUID, artifact: Artifact) -> str:
    return etags.compute(artifact_name(workspace_id, artifact.item_id), artifact.updated_at)


def is_text(artifact: Artifact, item: Item) -> bool:
    """Text kinds, and FILE artifacts whose content is text."""
    return artifact.kind in TEXT_KINDS or (
        artifact.kind == "file" and (item.mime_type or "").startswith("text/")
    )


# -- Access ------------------------------------------------------------------------------


async def open_artifact(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    artifact_id: UUID,
    permission: str,
    *,
    owner_only: bool,
    for_update: bool = False,
) -> tuple[Item, Artifact]:
    """The artifact if the caller may use it with ``permission`` (see the module docstring)."""
    name = artifact_name(workspace_id, artifact_id)
    row = await load_artifact(session, workspace_id, artifact_id, for_update=for_update)
    if row is None or is_purged(row[0].deleted_at):
        raise NotFound(f"Resource '{name}' was not found.")
    item, artifact = row
    if artifact.owner_user_id == ctx.user_id:
        return item, artifact
    if not await is_space_reader(session, ctx, workspace_id, item, artifact):
        raise NotFound(f"Resource '{name}' was not found.")
    if owner_only:
        raise PermissionDenied(
            f"Permission '{permission}' denied on resource '{name}' (or it might not exist)."
        )
    return item, artifact


async def is_space_reader(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item: Item, artifact: Artifact
) -> bool:
    return (
        artifact.audience == "space"
        and artifact.space_id is not None
        and item.deleted_at is None
        and await is_space_member(session, workspace_id, artifact.space_id, ctx.user_id)
    )


def require_state(item: Item, *, allowed: Iterable[str], action: str) -> None:
    state = artifact_state(item)
    if state not in allowed:
        raise FailedPrecondition(f"An artifact in state {state} cannot be {action}.")


def require_etag(workspace_id: UUID, artifact: Artifact, expected: str | None) -> None:
    etags.check(expected, etag_of(workspace_id, artifact))


# -- Spaces and audience -------------------------------------------------------------------


async def member_space(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, code: str, *, permission: str
) -> UUID:
    """The live space ``code`` the caller is a member of; PERMISSION_DENIED otherwise."""
    space_id = await space_id_for_code(session, workspace_id, code)
    if space_id is None or not await is_space_member(session, workspace_id, space_id, ctx.user_id):
        raise PermissionDenied(
            f"Permission '{permission}' denied on resource "
            f"'workspaces/{workspace_id}/spaces/{code}' (or it might not exist)."
        )
    return space_id


async def require_audience_reads(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    readers: Iterable[UUID],
    sources: Sequence[UUID],
) -> None:
    """AUDIENCE_CANNOT_READ_SOURCES unless every reader can read every source now."""
    if sources and await unreadable_items(ctx.authorizer, workspace_id, readers, sources):
        raise FailedPrecondition(
            "Some members of the audience cannot read every source of this artifact.",
            reason=AUDIENCE_CANNOT_READ_SOURCES,
        )


async def require_space_reads(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    space_id: UUID,
    sources: Sequence[UUID],
) -> None:
    readers = await space_member_ids(session, workspace_id, space_id)
    await require_audience_reads(session, ctx, workspace_id, readers, sources)


# -- Per-reader records ------------------------------------------------------------------------


def review_entries(value: Any) -> tuple[ReviewEntry, ...]:
    return tuple(
        ReviewEntry(
            key=str(entry["key"]),
            display_name=entry.get("display_name"),
            description=entry.get("description"),
        )
        for entry in (value or [])
    )


def review_json(entries: Iterable[ReviewEntry]) -> list[dict[str, Any]]:
    return [
        {"key": entry.key, "display_name": entry.display_name, "description": entry.description}
        for entry in entries
    ]


def stored_citations(value: Any) -> tuple[StoredCitation, ...]:
    return tuple(StoredCitation.from_json(entry) for entry in (value or []))


async def render_review(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    review: dict[str, Any],
    stored_cells: Sequence[tuple[str, str, str, str | None, tuple[StoredCitation, ...]]] | None,
) -> EvidenceReviewRecord:
    """The matrix for the caller: cells and the synthesis citing what they cannot read are withheld."""
    options, criteria = review_entries(review.get("options")), review_entries(review.get("criteria"))
    if stored_cells is None:
        return EvidenceReviewRecord(options, criteria, None, None, None)
    synthesis_citations = stored_citations(review.get("synthesis_citations"))
    cited = [c.item_id for *_, citations in stored_cells for c in citations]
    readable = await readable_summaries(
        session,
        ctx.authorizer,
        ctx.principal,
        workspace_id,
        [*cited, *(c.item_id for c in synthesis_citations)],
    )
    rendered: list[CellRecord] = []
    for option, criterion, state, summary, citations in stored_cells:
        if any(c.item_id not in readable for c in citations):
            rendered.append(CellRecord(option=option, criterion=criterion, available=False))
            continue
        rendered.append(
            CellRecord(
                option=option,
                criterion=criterion,
                available=True,
                state=state.upper(),
                summary=summary,
                citations=tuple(
                    await render_citations(
                        session, ctx.authorizer, ctx.principal, workspace_id, citations
                    )
                ),
            )
        )
    synthesis = review.get("synthesis")
    synthesis_available = all(c.item_id in readable for c in synthesis_citations)
    return EvidenceReviewRecord(
        options=options,
        criteria=criteria,
        cells=tuple(rendered),
        synthesis=synthesis if synthesis_available else None,
        synthesis_available=synthesis_available if synthesis is not None else None,
    )


def cell_rows(
    artifact: Artifact, rows: Sequence[EvidenceReviewCell]
) -> list[tuple[str, str, str, str | None, tuple[StoredCitation, ...]]]:
    """Cells in matrix order (options first)."""
    by_key = {(row.option_key, row.criterion_key): row for row in rows}
    return [
        (
            option,
            criterion,
            by_key[(option, criterion)].state,
            by_key[(option, criterion)].summary,
            stored_citations(by_key[(option, criterion)].citations),
        )
        for option, criterion in matrix_keys(artifact)
        if (option, criterion) in by_key
    ]


async def readable_sources(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, artifact: Artifact
) -> tuple[list[ItemSummary], int]:
    """The sources the caller can read now, and how many are withheld."""
    sources = await source_ids(session, artifact.item_id)
    readable = await readable_summaries(session, ctx.authorizer, ctx.principal, workspace_id, sources)
    return [readable[value] for value in sources if value in readable], len(sources) - len(
        [value for value in sources if value in readable]
    )


async def artifact_record(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    item: Item,
    artifact: Artifact,
    *,
    full: bool = True,
) -> ArtifactRecord:
    """The Artifact as the caller may see it now."""
    readable, hidden = await readable_sources(session, ctx, workspace_id, artifact)
    review = None
    if artifact.evidence_review is not None:
        stored = cell_rows(artifact, await cells(session, artifact.item_id)) if full else None
        review = await render_review(session, ctx, workspace_id, artifact.evidence_review, stored)
    current = await current_revision(session, item.id)
    spaces = await space_codes(session, [artifact.space_id]) if artifact.space_id else {}
    conversations = (
        await conversation_codes(session, [artifact.conversation_id])
        if artifact.conversation_id
        else {}
    )
    return ArtifactRecord(
        workspace_id=workspace_id,
        artifact_id=item.id,
        display_name=item.title,
        kind=artifact.kind.upper(),  # type: ignore[arg-type]
        mime_type=item.mime_type,
        owner_id=artifact.owner_user_id,
        conversation=(
            f"workspaces/{workspace_id}/conversations/{conversations[artifact.conversation_id]}"
            if artifact.conversation_id in conversations
            else None
        ),
        space=(
            f"workspaces/{workspace_id}/spaces/{spaces[artifact.space_id]}"
            if artifact.space_id in spaces
            else None
        ),
        audience=artifact.audience.upper(),  # type: ignore[arg-type]
        source_items=tuple(dict.fromkeys(summary.item_id for summary in readable)),
        hidden_source_count=hidden,
        evidence_review=review,
        state=artifact_state(item),  # type: ignore[arg-type]
        revision=current.revision_number if current is not None else None,
        create_time=artifact.created_at,
        update_time=artifact.updated_at,
        delete_time=item.deleted_at,
        purge_time=purge_time(item.deleted_at),
    )


async def withheld(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    artifact: Artifact,
    review: EvidenceReviewRecord | None,
) -> bool:
    """Whether a revision holds content the caller cannot read now.

    Text is derived from all sources together, so a single unreadable source
    withholds it; a matrix is withheld cell by cell, so only a withheld cell
    or synthesis counts.
    """
    if review is not None:
        return any(not cell.available for cell in review.cells or ()) or (
            review.synthesis_available is False
        )
    _, hidden = await readable_sources(session, ctx, workspace_id, artifact)
    return hidden > 0


async def revision_review(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    artifact: Artifact,
    data: bytes,
) -> EvidenceReviewRecord:
    """The matrix a revision object froze, for the caller."""
    document = json.loads(data)
    rows = [
        (
            cell["option"],
            cell["criterion"],
            cell["state"],
            cell.get("summary"),
            stored_citations(cell.get("citations")),
        )
        for cell in document.get("cells", [])
    ]
    return await render_review(session, ctx, workspace_id, document, rows)


async def snapshot_record(
    deps: ArtifactDeps,
    ctx: RequestContext,
    workspace_id: UUID,
    item: Item,
    artifact: Artifact,
    revision: ItemRevision,
    *,
    preview: bool,
) -> SnapshotRecord:
    """One revision for the caller, with its viewer preview when ``preview``.

    Runs outside the caller's transaction: objects are read and previews built
    between short read scopes.
    """
    engine = deps.engine
    if artifact.kind == "evidence_review":
        data = await engine.read_object(revision.storage_key)
        async with transaction_scope(deps.sessions) as session:
            review = await revision_review(session, ctx, workspace_id, artifact, data)
        return SnapshotRecord(
            mime_type=revision.mime_type, size_bytes=revision.size_bytes, evidence_review=review
        )
    async with transaction_scope(deps.sessions) as session:
        hidden = await withheld(session, ctx, workspace_id, artifact, None)
    if hidden:
        return SnapshotRecord(mime_type=revision.mime_type, size_bytes=revision.size_bytes)
    text = None
    content_uri = None
    if revision.mime_type.startswith("text/"):
        text = (await engine.read_object(revision.storage_key)).decode("utf-8", errors="replace")
    else:
        content_uri = engine.download_uri(revision.storage_key)
    page_assets: tuple[PageAsset, ...] = ()
    rendition = None
    viewed = await engine.revision_preview(item, revision) if preview else None
    if viewed is not None:
        expires = engine.download_url_seconds
        page_assets = resolve_page_assets(
            engine.preview, viewed.document, viewed.manifest, expires_seconds=expires
        )
        rendition = resolve_rendition(
            engine.preview, viewed.document, viewed.manifest, expires_seconds=expires
        )
    return SnapshotRecord(
        mime_type=revision.mime_type,
        size_bytes=revision.size_bytes,
        text=text,
        content_uri=content_uri,
        page_assets=page_assets,
        rendition=rendition,
    )


__all__ = [
    "AUDIENCE_CANNOT_READ_SOURCES",
    "TEXT_KINDS",
    "UNAVAILABLE_TEXT",
    "ArtifactDeps",
    "artifact_record",
    "cell_rows",
    "etag_of",
    "is_space_reader",
    "is_text",
    "member_space",
    "open_artifact",
    "readable_sources",
    "render_review",
    "require_audience_reads",
    "require_etag",
    "require_space_reads",
    "require_state",
    "review_entries",
    "review_json",
    "revision_name",
    "revision_review",
    "snapshot_record",
    "stored_citations",
    "withheld",
]
