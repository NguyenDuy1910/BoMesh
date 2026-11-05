"""Assistant interface — Artifacts slice: Artifacts and their revisions: create and revise (Operations), commit, export and publish.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from api.aip.fieldmask import MutableFields
from api.aip.paging import PageRequest, query_fingerprint
from api.dto.artifacts import (
    ARTIFACT_ORDER,
    ArtifactMessage,
    ArtifactRevisionMessage,
    CommitArtifactRequest,
    ListArtifactRevisionsResponse,
    ListArtifactsResponse,
    PublishArtifactRequest,
    PublishArtifactResponse,
    ReviseArtifactRequest,
    RollbackArtifactRequest,
    UndeleteArtifactRequest,
    View,
    artifact_filters,
    artifact_message,
    artifact_update,
    new_artifact,
    parse_revision,
    revision_message,
)
from api.dto.operations import OperationMessage, operation_message
from api.v1.deps import Context, service
from api.v1.listing import ListParams, list_query
from bomesh.services.artifacts.artifact_store import artifact_name
from bomesh.services.artifacts.artifacts import ArtifactResourceService
from bomesh.services.artifacts.records import Download
from bomesh.services.artifacts.revisions import ArtifactRevisionService
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.operations.operations import OperationService

router = APIRouter(tags=["Assistant"])

Artifacts = Annotated[ArtifactResourceService, Depends(service(ArtifactResourceService.from_runtime))]
Revisions = Annotated[ArtifactRevisionService, Depends(service(ArtifactRevisionService.from_runtime))]
Operations = Annotated[OperationService, Depends(service(OperationService.from_runtime))]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]
ExportMimeType = Literal[
    "text/csv",
    "application/pdf",
    "text/markdown",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]

_FIELDS = MutableFields(
    ("displayName", "audience", "space", "evidenceReview.options", "evidenceReview.criteria")
)
_ARTIFACTS = "/workspaces/{workspace:id}/artifacts"
_ARTIFACT = f"{_ARTIFACTS}/{{artifact:id}}"
_REVISION = f"{_ARTIFACT}/revisions/{{revision:id}}"


def _download(download: Download) -> Response:
    return Response(
        content=download.data,
        media_type=download.mime_type,
        headers={"Content-Disposition": f'attachment; filename="{download.file_name}"'},
    )


# -- Artifacts --------------------------------------------------------------------------------


@router.post(_ARTIFACTS, name="CreateArtifact")
async def create_artifact(
    workspace: UUID,
    body: ArtifactMessage,
    ctx: Context,
    artifacts: Artifacts,
    operations: Operations,
    request_id: RequestId = None,
) -> OperationMessage:
    spec = new_artifact(body, workspace)
    operation = await artifacts.create(ctx, workspace, spec, request_id=request_id)
    return operation_message(await operations.describe(operation))


@router.get(_ARTIFACTS, name="ListArtifacts")
async def list_artifacts(
    workspace: UUID,
    params: Annotated[ListParams, Depends()],
    ctx: Context,
    artifacts: Artifacts,
    view: Annotated[View, Query()] = "BASIC",
) -> ListArtifactsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=artifact_filters(workspace),
        order=ARTIFACT_ORDER,
    )
    records, total = await artifacts.list(ctx, workspace, query, full=view == "FULL")
    page = paging.page(records)
    return ListArtifactsResponse(
        artifacts=[artifact_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get(_ARTIFACT, name="GetArtifact", response_model=ArtifactMessage)
async def get_artifact(
    workspace: UUID,
    artifact: UUID,
    ctx: Context,
    artifacts: Artifacts,
    alt: Annotated[Literal["json", "media"], Query()] = "json",
    view: Annotated[View, Query()] = "FULL",
) -> Any:
    if alt == "media":
        return _download(await artifacts.media(ctx, workspace, artifact))
    return artifact_message(await artifacts.get(ctx, workspace, artifact, full=view == "FULL"))


@router.patch(_ARTIFACT, name="UpdateArtifact")
async def update_artifact(
    workspace: UUID,
    artifact: UUID,
    body: ArtifactMessage,
    ctx: Context,
    artifacts: Artifacts,
    update_mask: Annotated[str | None, Query(alias="updateMask")] = None,
) -> ArtifactMessage:
    change = artifact_update(_FIELDS.parse(update_mask, body), body, workspace)
    record = await artifacts.update(ctx, workspace, artifact, change, etag=body.etag)
    return artifact_message(record)


@router.delete(_ARTIFACT, name="DeleteArtifact")
async def delete_artifact(
    workspace: UUID, artifact: UUID, ctx: Context, artifacts: Artifacts, etag: Etag = None
) -> ArtifactMessage:
    return artifact_message(await artifacts.delete(ctx, workspace, artifact, etag=etag))


@router.post(f"{_ARTIFACT}:undelete", name="UndeleteArtifact")
async def undelete_artifact(
    workspace: UUID, artifact: UUID, body: UndeleteArtifactRequest, ctx: Context, artifacts: Artifacts
) -> ArtifactMessage:
    return artifact_message(await artifacts.undelete(ctx, workspace, artifact, etag=body.etag))


@router.post(f"{_ARTIFACT}:revise", name="ReviseArtifact")
async def revise_artifact(
    workspace: UUID,
    artifact: UUID,
    body: ReviseArtifactRequest,
    ctx: Context,
    artifacts: Artifacts,
    operations: Operations,
) -> OperationMessage:
    operation = await artifacts.revise(ctx, workspace, artifact, body.revise(), etag=body.etag)
    return operation_message(await operations.describe(operation))


@router.post(f"{_ARTIFACT}:commit", name="CommitArtifact")
async def commit_artifact(
    workspace: UUID, artifact: UUID, body: CommitArtifactRequest, ctx: Context, artifacts: Artifacts
) -> ArtifactMessage:
    record = await artifacts.commit(
        ctx, workspace, artifact, text=body.text, change_summary=body.change_summary, etag=body.etag
    )
    return artifact_message(record)


@router.get(f"{_ARTIFACT}:export", name="ExportArtifact", response_class=Response)
async def export_artifact(
    workspace: UUID,
    artifact: UUID,
    ctx: Context,
    artifacts: Artifacts,
    mime_type: Annotated[ExportMimeType, Query(alias="mimeType")],
    revision: Annotated[str | None, Query()] = None,
) -> Response:
    number = parse_revision(revision, workspace, artifact, field="revision") if revision else None
    download = await artifacts.export(ctx, workspace, artifact, mime_type=mime_type, revision=number)
    return _download(download)


@router.post(f"{_ARTIFACT}:publish", name="PublishArtifact")
async def publish_artifact(
    workspace: UUID,
    artifact: UUID,
    body: PublishArtifactRequest,
    ctx: Context,
    artifacts: Artifacts,
    request_id: RequestId = None,
) -> PublishArtifactResponse:
    collection = parse_item(body.collection, workspace, field="collection")
    item = await artifacts.publish(
        ctx, workspace, artifact, collection, etag=body.etag, request_id=request_id
    )
    return PublishArtifactResponse(item=item)


# -- Revisions --------------------------------------------------------------------------------


@router.get(f"{_ARTIFACT}/revisions", name="ListArtifactRevisions")
async def list_artifact_revisions(
    workspace: UUID,
    artifact: UUID,
    ctx: Context,
    revisions: Revisions,
    page_size: Annotated[int | None, Query(alias="pageSize")] = None,
    page_token: Annotated[str | None, Query(alias="pageToken")] = None,
) -> ListArtifactRevisionsResponse:
    paging = PageRequest.from_params(
        page_size, page_token, query_fingerprint(parent=artifact_name(workspace, artifact))
    )
    records, total = await revisions.list(
        ctx, workspace, artifact, offset=paging.offset, limit=paging.fetch_limit
    )
    page = paging.page(records)
    return ListArtifactRevisionsResponse(
        revisions=[revision_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=total,
    )


@router.get(_REVISION, name="GetArtifactRevision")
async def get_artifact_revision(
    workspace: UUID, artifact: UUID, revision: str, ctx: Context, revisions: Revisions
) -> ArtifactRevisionMessage:
    number = parse_revision(revision, workspace, artifact, field="revision")
    return revision_message(await revisions.get(ctx, workspace, artifact, number))


@router.delete(_REVISION, name="DeleteArtifactRevision")
async def delete_artifact_revision(
    workspace: UUID, artifact: UUID, revision: str, ctx: Context, revisions: Revisions
) -> dict[str, Any]:
    number = parse_revision(revision, workspace, artifact, field="revision")
    await revisions.delete(ctx, workspace, artifact, number)
    return {}


@router.post(f"{_REVISION}:rollback", name="RollbackArtifact")
async def rollback_artifact(
    workspace: UUID,
    artifact: UUID,
    revision: str,
    body: RollbackArtifactRequest,
    ctx: Context,
    revisions: Revisions,
) -> ArtifactMessage:
    number = parse_revision(revision, workspace, artifact, field="revision")
    return artifact_message(await revisions.rollback(ctx, workspace, artifact, number, etag=body.etag))
