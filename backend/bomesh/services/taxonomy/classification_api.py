"""Taxonomy classification endpoints: TestClassification, CompileClassificationPrompt,
ConfirmConceptAssignments and RejectConceptAssignments.

TestClassification runs CLASSIFYING of a sample exactly as processing does
(:func:`~bomesh.services.taxonomy.classification.load_plan` → ``prepare`` →
the model → ``decide``) and writes nothing. Confirm/Reject resolve a ListItems
filter to the visible documents whose governing collection grants the caller
``items.update`` (narrowed silently) and hand them to
:mod:`bomesh.services.taxonomy.assignments`, which audits.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Concept, ConceptScheme, IngestionSource, Item, Tenant
from bomesh.document_index import (
    ClassificationRequest,
    SchemeTask,
    classification_prompt,
    sample_document_context,
)
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound, Unavailable
from bomesh.iam.authorizer import ItemRef, WorkspaceRef, item_ancestry, permission_denied
from bomesh.iam.visibility import ItemVisibility, item_visibility, require_visible_item
from bomesh.services.kernel.context import RequestContext
from bomesh.services.knowledge_items.records import Applicability, ConceptKey, Issuance
from bomesh.services.knowledge_items.support import KnowledgeDeps
from bomesh.services.taxonomy import assignments
from bomesh.services.taxonomy.classification import (
    ClassificationPlan,
    DocumentInput,
    ExtractedMetadata,
    Signals,
    decide,
    load_plan,
    prepare,
)
from bomesh.services.taxonomy.names import concept_name

#: The leading text a sample offers the rules (as ``DocumentInput.head``).
_HEAD_CHARACTERS = 4000
_PROMPT_NOTE = "[the run's note for the assistant]"
_PROMPT_TITLE = "[document title]"
_PROMPT_DOCUMENT = "[document metadata and leading excerpts, up to 12,000 characters]"


@dataclass(frozen=True, slots=True)
class SampleAssignment:
    concept: ConceptKey
    primary: bool
    section_ref: str | None
    confidence: float | None
    #: rule|lexical|knn|llm
    source: str
    #: accepted|suggested
    state: str
    quote: str | None


@dataclass(frozen=True, slots=True)
class SampleOutcome:
    scheme: str
    #: assigned|empty|uncertain|failed
    outcome: str
    confidence: float | None


@dataclass(frozen=True, slots=True)
class SampleCandidate:
    scheme: str
    concept: ConceptKey
    score: float
    #: (kind, score): kind ∈ rule|lexical|card|knn|prior
    signals: tuple[tuple[str, float], ...]


@dataclass(frozen=True, slots=True)
class ClassificationTest:
    assignments: tuple[SampleAssignment, ...]
    outcomes: tuple[SampleOutcome, ...]
    candidates: tuple[SampleCandidate, ...]
    issuance: Issuance | None
    applicability: Applicability | None
    summary: str | None
    model_called: bool


@dataclass(frozen=True, slots=True)
class ClassificationPromptPreview:
    prompt: str
    #: ``concept_rules.code`` of every live rule checked before the model.
    rules: tuple[str, ...]
    estimated_tokens: int


class ClassificationApiService:
    def __init__(self, deps: KnowledgeDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ClassificationApiService:
        return cls(KnowledgeDeps.from_runtime(runtime))

    # -- TestClassification / CompileClassificationPrompt ------------------------

    async def test(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        *,
        title: str,
        text: str,
        collection_id: UUID | None,
        source_code: str | None,
    ) -> ClassificationTest:
        """TestClassification: CLASSIFYING of a sample; nothing is written."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "conceptSchemes.update", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            plan = await _plan(session, workspace_id)
            ancestors: tuple[UUID, ...] = ()
            if collection_id is not None:
                collection = await _visible_item(session, ctx, workspace_id, collection_id)
                if collection.item_kind != "collection":
                    raise InvalidArgument.for_field(
                        "collection", "collection must be a COLLECTION item."
                    )
                ancestors = tuple(
                    node.item_id for node in await item_ancestry(session, collection_id)
                )
            source_id = (
                await _source_id(session, workspace_id, source_code) if source_code else None
            )
        doc = DocumentInput(
            title=title,
            context=sample_document_context(title, text),
            head=text[:_HEAD_CHARACTERS],
            ancestor_ids=ancestors,
            source_id=source_id,
            item_id=None,
        )
        signals = Signals(
            sessions=self._deps.sessions, index=self._deps.index, storage=self._deps.storage
        )
        prepared = await prepare(plan, doc, signals)
        try:
            answer = await self._deps.index.classify_sample(
                title=title, text=text, request=prepared.request
            )
        except Exception as exc:
            raise Unavailable("The classification model did not answer; try again.") from exc
        if answer is None and prepared.request.needs_model:
            raise FailedPrecondition(
                "The schemes need the model and the contextualization model is not configured."
            )
        outcome = decide(plan, prepared, answer)
        key = _keys(plan)
        return ClassificationTest(
            assignments=tuple(
                SampleAssignment(
                    concept=key(row.concept_id),
                    primary=row.primary,
                    section_ref=row.section_ref,
                    confidence=row.confidence,
                    source=row.source,
                    state=row.state,
                    quote=row.evidence.get("quote"),
                )
                for result in outcome.schemes
                for row in result.assignments
            ),
            outcomes=tuple(
                SampleOutcome(
                    scheme=result.scheme_code,
                    outcome=result.outcome,
                    confidence=result.confidence,
                )
                for result in outcome.schemes
            ),
            candidates=tuple(
                SampleCandidate(
                    scheme=scheme,
                    concept=key(candidate.concept_id),
                    score=candidate.score,
                    signals=tuple(candidate.scores),
                )
                for scheme, ranked in prepared.candidates.items()
                for candidate in ranked
            ),
            issuance=_issuance(outcome.metadata, key),
            applicability=_applicability(outcome.metadata, key),
            summary=outcome.summary,
            model_called=outcome.model_called,
        )

    async def compile_prompt(
        self, ctx: RequestContext, workspace_id: UUID
    ) -> ClassificationPromptPreview:
        """CompileClassificationPrompt: the shared prefix over every published
        classification scheme, then one document's part with placeholders and every
        scheme asked, and the rules checked before the model."""
        await self._deps.workspaces.open(
            ctx, WorkspaceRef(workspace_id), "conceptSchemes.update", write=False
        )
        async with transaction_scope(self._deps.sessions) as session:
            plan = await _plan(session, workspace_id)
        request = ClassificationRequest(
            schemes=plan.prompt_schemes,
            note=_PROMPT_NOTE,
            fingerprint=plan.fingerprint,
            tasks=tuple(SchemeTask(scheme=scheme.code, ask=True) for scheme in plan.prompt_schemes),
        )
        compiled = classification_prompt(request)
        prompt = "\n\n".join(
            (
                compiled.prefix,
                compiled.document(request, title=_PROMPT_TITLE, document_context=_PROMPT_DOCUMENT),
            )
        )
        # About four characters per token; the provider's tokenizer decides.
        return ClassificationPromptPreview(
            prompt=prompt,
            rules=tuple(rule.code for rule in plan.rules),
            estimated_tokens=math.ceil(len(prompt) / 4),
        )

    # -- Confirm / Reject ---------------------------------------------------------

    async def confirm(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        concept: ConceptKey,
        where: ColumnElement[bool],
        *,
        referenced: frozenset[UUID] = frozenset(),
    ) -> int:
        """ConfirmConceptAssignments: the concept's SUGGESTED labels on the matching
        documents become ACCEPTED by the caller. Returns how many changed."""
        return await self._decide(ctx, workspace_id, concept, where, referenced, confirm=True)

    async def reject(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        concept: ConceptKey,
        where: ColumnElement[bool],
        *,
        referenced: frozenset[UUID] = frozenset(),
    ) -> int:
        """RejectConceptAssignments: the concept's labels on the matching documents
        become REJECTED by the caller. Returns how many changed."""
        return await self._decide(ctx, workspace_id, concept, where, referenced, confirm=False)

    async def _decide(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        concept: ConceptKey,
        where: ColumnElement[bool],
        referenced: frozenset[UUID],
        *,
        confirm: bool,
    ) -> int:
        # Any member may call; items.update is checked per document by the narrowing below.
        await self._deps.workspaces.open(ctx, WorkspaceRef(workspace_id), "concepts.get", write=True)
        visibility = await item_visibility(ctx.authorizer, ctx.principal, workspace_id)
        # Documents governed by a collection the caller both reads and edits.
        editable = ItemVisibility(
            workspace_id, visibility.readable & visibility.editable, visibility.editable
        )
        documents = select(Item.id).where(
            Item.item_kind == "document", Item.deleted_at.is_(None), editable.clause(), where
        )
        async with transaction_scope(self._deps.sessions) as session:
            concept_id = await _published_concept(session, workspace_id, concept)
            for item_id in referenced:
                await _visible_item(session, ctx, workspace_id, item_id)
            item_ids = list(await session.scalars(documents))
            if confirm:
                return await assignments.confirm(session, ctx, concept_id, item_ids)
            return await assignments.reject(session, ctx, concept_id, item_ids)


async def _plan(session: AsyncSession, workspace_id: UUID) -> ClassificationPlan:
    code = await session.scalar(select(Tenant.code).where(Tenant.id == workspace_id))
    assert code is not None
    plan = await load_plan(session, workspace_id, None, workspace_code=code)
    if plan is None:
        raise FailedPrecondition(
            "The workspace has no published classification scheme.", reason="NO_PUBLISHED_SCHEME"
        )
    return plan


async def _visible_item(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, item_id: UUID
) -> Item:
    """An item a request names: one the caller cannot see is PERMISSION_DENIED."""
    ref = ItemRef(workspace_id, item_id)
    try:
        return await require_visible_item(session, ctx.authorizer, ctx.principal, ref)
    except NotFound:
        raise permission_denied("items.get", ref) from None


async def _source_id(session: AsyncSession, workspace_id: UUID, code: str) -> UUID:
    source_id = await session.scalar(
        select(IngestionSource.id).where(
            IngestionSource.tenant_id == workspace_id,
            IngestionSource.code == code,
            IngestionSource.deleted_at.is_(None),
        )
    )
    if source_id is None:
        raise InvalidArgument.for_field("source", "The source does not exist.")
    return source_id


async def _published_concept(session: AsyncSession, workspace_id: UUID, key: ConceptKey) -> UUID:
    scheme_code, notation = key
    row = (
        await session.execute(
            select(Concept.id, Concept.state)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(
                ConceptScheme.tenant_id == workspace_id,
                ConceptScheme.deleted_at.is_(None),
                ConceptScheme.code == scheme_code,
                Concept.notation == notation,
                Concept.deleted_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise NotFound(f"'{concept_name(workspace_id, scheme_code, notation)}' was not found.")
    if row.state != "published":
        raise FailedPrecondition("Only a PUBLISHED concept's assignments can be decided.")
    return row.id


def _keys(plan: ClassificationPlan) -> Any:
    def key(concept_id: UUID) -> ConceptKey:
        view = plan.taxonomy.by_concept(concept_id)
        assert view is not None
        return (view.scheme_code, view.notation)

    return key


def _issuance(metadata: ExtractedMetadata, key: Any) -> Issuance | None:
    if not (
        metadata.number
        or metadata.issued_on
        or metadata.effective_on
        or metadata.issuer_concept_id
        or metadata.campus_concept_id
    ):
        return None
    return Issuance(
        issuer=key(metadata.issuer_concept_id) if metadata.issuer_concept_id else None,
        campus=key(metadata.campus_concept_id) if metadata.campus_concept_id else None,
        number=metadata.number,
        issued_on=metadata.issued_on,
        effective_on=metadata.effective_on,
        # Printed numbers of the superseded documents resolve only when stored.
        supersedes=(),
    )


def _applicability(metadata: ExtractedMetadata, key: Any) -> Applicability | None:
    if metadata.level is None:
        return None
    return Applicability(
        level=metadata.level,
        units=tuple(key(cid) for cid in metadata.unit_ids),
        programs=tuple(key(cid) for cid in metadata.program_ids),
        cohorts=tuple(metadata.cohorts),
    )


__all__ = [
    "ClassificationApiService",
    "ClassificationPromptPreview",
    "ClassificationTest",
    "SampleAssignment",
    "SampleCandidate",
    "SampleOutcome",
]
