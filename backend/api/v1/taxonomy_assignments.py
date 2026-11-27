"""Knowledge interface — taxonomy classification: TestClassification,
CompileClassificationPrompt and Confirm/RejectConceptAssignments.

Routes are mounted under ``/api/v1``; ``name`` is the contract ``operationId``.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from api.dto.knowledge_items import item_filters, referenced_items
from api.dto.taxonomy_assignments import (
    CompileClassificationPromptResponse,
    ConfirmConceptAssignmentsRequest,
    ConfirmConceptAssignmentsResponse,
    RejectConceptAssignmentsRequest,
    RejectConceptAssignmentsResponse,
    TestClassificationRequest,
    TestClassificationResponse,
    compile_prompt_response,
    test_classification_response,
)
from api.v1.deps import Context, Runtime, service
from bomesh.services.ingestion.names import parse_source
from bomesh.services.knowledge_items.names import parse_item
from bomesh.services.taxonomy.classification_api import ClassificationApiService

router = APIRouter(tags=["Knowledge"])

Classifications = Annotated[
    ClassificationApiService, Depends(service(ClassificationApiService.from_runtime))
]

_SCHEMES = "/workspaces/{workspace:id}/conceptSchemes"
_CONCEPT = f"{_SCHEMES}/{{conceptScheme:id}}/concepts/{{concept:id}}"


@router.post(f"{_SCHEMES}:testClassification", name="TestClassification")
async def test_classification(
    workspace: UUID, body: TestClassificationRequest, ctx: Context, classifications: Classifications
) -> TestClassificationResponse:
    result = await classifications.test(
        ctx,
        workspace,
        title=body.title,
        text=body.text or "",
        collection_id=(
            parse_item(body.collection, workspace, field="collection") if body.collection else None
        ),
        source_code=parse_source(body.source, workspace, field="source") if body.source else None,
    )
    return test_classification_response(workspace, result)


@router.get(f"{_SCHEMES}:compileClassificationPrompt", name="CompileClassificationPrompt")
async def compile_classification_prompt(
    workspace: UUID, ctx: Context, classifications: Classifications
) -> CompileClassificationPromptResponse:
    return compile_prompt_response(workspace, await classifications.compile_prompt(ctx, workspace))


@router.post(f"{_CONCEPT}:confirmAssignments", name="ConfirmConceptAssignments")
async def confirm_concept_assignments(
    workspace: UUID,
    conceptScheme: str,  # noqa: N803 - the contract's path variable
    concept: str,
    body: ConfirmConceptAssignmentsRequest,
    ctx: Context,
    classifications: Classifications,
    runtime: Runtime,
) -> ConfirmConceptAssignmentsResponse:
    where = item_filters(workspace, runtime.processing_version()).compile(body.filter)
    confirmed = await classifications.confirm(
        ctx,
        workspace,
        (conceptScheme, concept),
        where,
        referenced=referenced_items(body.filter, workspace),
    )
    return ConfirmConceptAssignmentsResponse(confirmed_count=confirmed)


@router.post(f"{_CONCEPT}:rejectAssignments", name="RejectConceptAssignments")
async def reject_concept_assignments(
    workspace: UUID,
    conceptScheme: str,  # noqa: N803 - the contract's path variable
    concept: str,
    body: RejectConceptAssignmentsRequest,
    ctx: Context,
    classifications: Classifications,
    runtime: Runtime,
) -> RejectConceptAssignmentsResponse:
    where = item_filters(workspace, runtime.processing_version()).compile(body.filter)
    rejected = await classifications.reject(
        ctx,
        workspace,
        (conceptScheme, concept),
        where,
        referenced=referenced_items(body.filter, workspace),
    )
    return RejectConceptAssignmentsResponse(rejected_count=rejected)
