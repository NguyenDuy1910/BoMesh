"""Taxonomy classification messages (``openapi.yaml`` tag Knowledge): TestClassification,
CompileClassificationPrompt, Confirm/RejectConceptAssignments."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field

from api.aip.messages import ProtoMessage
from api.dto.knowledge_items import (
    DocumentApplicability,
    DocumentConcept,
    DocumentConceptEvidence,
    DocumentIssuance,
    applicability_message,
    issuance_message,
)
from bomesh.services.taxonomy.classification_api import (
    ClassificationPromptPreview,
    ClassificationTest,
)
from bomesh.services.taxonomy.names import concept_name, rule_name, scheme_name


class TestClassificationRequest(ProtoMessage):
    title: str = Field(max_length=1024)
    text: str | None = Field(default=None, max_length=20000)
    collection: str | None = None
    source: str | None = None


class ClassificationOutcome(ProtoMessage):
    scheme: str | None = None
    outcome: Literal["ASSIGNED", "EMPTY", "UNCERTAIN", "FAILED"] | None = None
    confidence: float | None = None


class ClassificationSignal(ProtoMessage):
    kind: Literal["RULE", "LEXICAL", "CARD", "KNN", "PRIOR"] | None = None
    score: float | None = None


class ClassificationCandidate(ProtoMessage):
    scheme: str | None = None
    concept: str | None = None
    score: float | None = None
    signals: list[ClassificationSignal] | None = None


class TestClassificationResponse(ProtoMessage):
    assignments: list[DocumentConcept] | None = None
    outcomes: list[ClassificationOutcome] | None = None
    candidates: list[ClassificationCandidate] | None = None
    issuance: DocumentIssuance | None = None
    applicability: DocumentApplicability | None = None
    summary: str | None = None
    model_called: bool | None = None


class CompileClassificationPromptResponse(ProtoMessage):
    prompt: str | None = None
    rules: list[str] | None = None
    estimated_tokens: int | None = None


class ConfirmConceptAssignmentsRequest(ProtoMessage):
    filter: str | None = None


class ConfirmConceptAssignmentsResponse(ProtoMessage):
    confirmed_count: int


class RejectConceptAssignmentsRequest(ProtoMessage):
    filter: str | None = None


class RejectConceptAssignmentsResponse(ProtoMessage):
    rejected_count: int


def test_classification_response(
    workspace_id: UUID, result: ClassificationTest
) -> TestClassificationResponse:
    ws = workspace_id
    return TestClassificationResponse(
        assignments=[
            DocumentConcept(
                concept=concept_name(ws, *row.concept),
                scheme=scheme_name(ws, row.concept[0]),
                primary=row.primary,
                section=row.section_ref,
                confidence=row.confidence,
                source=row.source.upper(),  # type: ignore[arg-type]
                state=row.state.upper(),  # type: ignore[arg-type]
                evidence=DocumentConceptEvidence(quote=row.quote) if row.quote else None,
            )
            for row in result.assignments
        ],
        outcomes=[
            ClassificationOutcome(
                scheme=scheme_name(ws, outcome.scheme),
                outcome=outcome.outcome.upper(),  # type: ignore[arg-type]
                confidence=outcome.confidence,
            )
            for outcome in result.outcomes
        ],
        candidates=[
            ClassificationCandidate(
                scheme=scheme_name(ws, candidate.scheme),
                concept=concept_name(ws, *candidate.concept),
                score=candidate.score,
                signals=[
                    ClassificationSignal(kind=kind.upper(), score=score)  # type: ignore[arg-type]
                    for kind, score in candidate.signals
                ],
            )
            for candidate in result.candidates
        ],
        issuance=issuance_message(ws, result.issuance),
        applicability=applicability_message(ws, result.applicability),
        summary=result.summary,
        model_called=result.model_called,
    )


def compile_prompt_response(
    workspace_id: UUID, result: ClassificationPromptPreview
) -> CompileClassificationPromptResponse:
    return CompileClassificationPromptResponse(
        prompt=result.prompt,
        rules=[rule_name(workspace_id, code) for code in result.rules],
        estimated_tokens=result.estimated_tokens,
    )


__all__ = [
    "ClassificationCandidate",
    "ClassificationOutcome",
    "ClassificationSignal",
    "CompileClassificationPromptResponse",
    "ConfirmConceptAssignmentsRequest",
    "ConfirmConceptAssignmentsResponse",
    "RejectConceptAssignmentsRequest",
    "RejectConceptAssignmentsResponse",
    "TestClassificationRequest",
    "TestClassificationResponse",
    "compile_prompt_response",
    "test_classification_response",
]
