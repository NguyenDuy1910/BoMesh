"""Knowledge interface — KnowledgeCuration slice: Contributions.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from api.dto.identity import Empty
from api.dto.knowledge_curation import (
    CONTRIBUTION_ORDER,
    ApproveContributionRequest,
    ContributionMessage,
    DecisionRequest,
    EtagRequest,
    ListContributionsResponse,
    ResubmitContributionRequest,
    View,
    contribution_filters,
    contribution_message,
    referenced_collections,
)
from api.v1.deps import Context, Runtime, service
from api.v1.listing import ListParams, list_query
from bomesh.errors import InvalidArgument
from bomesh.services.knowledge_curation.contributions import ContributionService
from bomesh.services.knowledge_curation.records import Approval, ContributionDraft
from bomesh.services.knowledge_items.names import parse_item

router = APIRouter(tags=["Knowledge"])

Contributions = Annotated[
    ContributionService, Depends(service(ContributionService.from_runtime))
]

RequestId = Annotated[UUID | None, Query(alias="requestId")]
Etag = Annotated[str | None, Query()]

_WS = "/workspaces/{workspace:id}"
_CONTRIBUTION = f"{_WS}/contributions/{{contribution:id}}"


# -- Contributions -------------------------------------------------------------------


@router.post(f"{_WS}/contributions", name="CreateContribution")
async def create_contribution(
    workspace: UUID,
    body: ContributionMessage,
    ctx: Context,
    contributions: Contributions,
    request_id: RequestId = None,
) -> ContributionMessage:
    if not body.item:
        raise InvalidArgument.for_field("item", "item is required.")
    draft = ContributionDraft(
        kind=(body.kind or "NEW_DOCUMENT").lower(),
        item_id=parse_item(body.item, workspace, field="item"),
        target_id=parse_item(body.target_collection, workspace, field="targetCollection")
        if body.target_collection
        else None,
        replaces_id=parse_item(body.replaces_item, workspace, field="replacesItem")
        if body.replaces_item
        else None,
        note=body.note,
        change_summary=body.change_summary,
    )
    record = await contributions.create(ctx, workspace, draft, request_id=request_id)
    return contribution_message(record)


@router.get(f"{_WS}/contributions", name="ListContributions")
async def list_contributions(
    workspace: UUID,
    ctx: Context,
    contributions: Contributions,
    runtime: Runtime,
    params: Annotated[ListParams, Depends()],
    view: Annotated[View, Query()] = "BASIC",
) -> ListContributionsResponse:
    query, paging = list_query(
        params,
        parent=f"workspaces/{workspace}",
        filters=contribution_filters(
            workspace, ctx.principal.user_id, runtime.processing_version()
        ),
        order=CONTRIBUTION_ORDER,
    )
    rows, total = await contributions.list(
        ctx,
        workspace,
        query,
        full=view == "FULL",
        referenced_collections=referenced_collections(params.filter, workspace),
    )
    page = paging.page(rows, total_size=total)
    return ListContributionsResponse(
        contributions=[contribution_message(record) for record in page.items],
        next_page_token=page.next_page_token or None,
        total_size=page.total_size,
    )


@router.get(_CONTRIBUTION, name="GetContribution")
async def get_contribution(
    workspace: UUID,
    contribution: UUID,
    ctx: Context,
    contributions: Contributions,
    view: Annotated[View, Query()] = "FULL",
) -> ContributionMessage:
    record = await contributions.get(ctx, workspace, contribution, full=view != "BASIC")
    return contribution_message(record)


@router.delete(_CONTRIBUTION, name="DeleteContribution")
async def delete_contribution(
    workspace: UUID,
    contribution: UUID,
    ctx: Context,
    contributions: Contributions,
    etag: Etag = None,
) -> Empty:
    await contributions.delete(ctx, workspace, contribution, etag=etag)
    return Empty()


@router.post(f"{_CONTRIBUTION}:approve", name="ApproveContribution")
async def approve_contribution(
    workspace: UUID,
    contribution: UUID,
    body: ApproveContributionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    approval = Approval(
        etag=body.etag,
        target_id=parse_item(body.target_collection, workspace, field="targetCollection")
        if body.target_collection
        else None,
        concepts=tuple(body.concepts) if body.concepts is not None else None,
        summary=body.summary,
        title=body.title,
    )
    return contribution_message(await contributions.approve(ctx, workspace, contribution, approval))


@router.post(f"{_CONTRIBUTION}:reject", name="RejectContribution")
async def reject_contribution(
    workspace: UUID,
    contribution: UUID,
    body: DecisionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.reject(
        ctx, workspace, contribution, message=body.message, etag=body.etag
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:requestChanges", name="RequestContributionChanges")
async def request_contribution_changes(
    workspace: UUID,
    contribution: UUID,
    body: DecisionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.request_changes(
        ctx, workspace, contribution, message=body.message, etag=body.etag
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:resubmit", name="ResubmitContribution")
async def resubmit_contribution(
    workspace: UUID,
    contribution: UUID,
    body: ResubmitContributionRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.resubmit(
        ctx,
        workspace,
        contribution,
        change_summary=body.change_summary,
        item_id=parse_item(body.item, workspace, field="item") if body.item else None,
        note=body.note,
        etag=body.etag,
    )
    return contribution_message(record)


@router.post(f"{_CONTRIBUTION}:withdraw", name="WithdrawContribution")
async def withdraw_contribution(
    workspace: UUID,
    contribution: UUID,
    body: EtagRequest,
    ctx: Context,
    contributions: Contributions,
) -> ContributionMessage:
    record = await contributions.withdraw(ctx, workspace, contribution, etag=body.etag)
    return contribution_message(record)
