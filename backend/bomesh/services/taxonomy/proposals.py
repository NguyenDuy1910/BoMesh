"""Concept proposals: new concepts or labels suggested by clustering, corrections or members.

The classifier never creates concepts. Accepting a NEW_CONCEPT proposal creates
a DRAFT concept (CreateConcept rules) and records it; accepting a LABEL
proposal adds the text as an alt (or hidden) label of the target concept in
the working copy. Both reach classification at the next publish. ``evidence``
lists only the documents the caller can read.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item
from bomesh.db.models.taxonomy import Concept, ConceptProposal, ConceptProposalItem, ConceptScheme
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.taxonomy.concepts import ConceptService, SchemeIndex, visible_documents, write_concept
from bomesh.services.taxonomy.names import concept_name, is_code, parse_concept, proposal_name, scheme_name
from bomesh.services.taxonomy.records import ProposalRecord
from bomesh.services.taxonomy.support import TaxonomyDeps, audit, authorize, concept_views, now


async def proposal_records(
    session: AsyncSession, ctx: RequestContext, workspace_id: UUID, proposals: Sequence[ConceptProposal]
) -> list[ProposalRecord]:
    if not proposals:
        return []
    scheme_codes = dict(
        (
            await session.execute(
                select(ConceptScheme.id, ConceptScheme.code).where(
                    ConceptScheme.id.in_({proposal.scheme_id for proposal in proposals})
                )
            )
        ).tuples().all()
    )
    concept_ids = {
        value
        for proposal in proposals
        for value in (proposal.broader_concept_id, proposal.target_concept_id, proposal.concept_id)
        if value is not None
    }
    notations = (
        dict(
            (await session.execute(select(Concept.id, Concept.notation).where(Concept.id.in_(concept_ids))))
            .tuples()
            .all()
        )
        if concept_ids
        else {}
    )
    visible = await visible_documents(ctx.authorizer, ctx.principal, workspace_id)
    evidence: dict[UUID, list[UUID]] = {}
    for proposal_id, item_id in (
        await session.execute(
            select(ConceptProposalItem.proposal_id, ConceptProposalItem.item_id)
            .join(Item, Item.id == ConceptProposalItem.item_id)
            .where(ConceptProposalItem.proposal_id.in_([proposal.id for proposal in proposals]), visible)
            .order_by(ConceptProposalItem.proposal_id, Item.created_at, Item.id)
        )
    ).tuples():
        evidence.setdefault(proposal_id, []).append(item_id)

    def name(proposal: ConceptProposal, cid: UUID | None) -> str | None:
        if cid is None or cid not in notations:
            return None
        return concept_name(workspace_id, scheme_codes[proposal.scheme_id], notations[cid])

    return [
        ProposalRecord(
            name=proposal_name(workspace_id, proposal.id),
            scheme=scheme_name(workspace_id, scheme_codes[proposal.scheme_id]),
            kind=proposal.kind,
            display_name=proposal.proposal_name,
            definition=proposal.definition,
            suggested_broader=name(proposal, proposal.broader_concept_id),
            target_concept=name(proposal, proposal.target_concept_id),
            origin=proposal.origin,
            state=proposal.state,
            concept=name(proposal, proposal.concept_id),
            evidence=tuple(item_name(workspace_id, item_id) for item_id in evidence.get(proposal.id, ())),
            decider=f"users/{proposal.decided_by_user_id}" if proposal.decided_by_user_id else None,
            decide_time=proposal.decided_at,
            create_time=proposal.created_at,
        )
        for proposal in proposals
    ]


class ProposalService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ProposalService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[ProposalRecord], int]:
        await authorize(ctx, workspace_id, "conceptProposals.list", write=False)
        statement = select(ConceptProposal).where(ConceptProposal.tenant_id == workspace_id)
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            proposals = list(await session.scalars(query.apply(statement)))
            return await proposal_records(session, ctx, workspace_id, proposals), total

    async def get(self, ctx: RequestContext, workspace_id: UUID, proposal_id: UUID) -> ProposalRecord:
        await authorize(ctx, workspace_id, "conceptProposals.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            proposal = await self._load(session, workspace_id, proposal_id)
            return (await proposal_records(session, ctx, workspace_id, [proposal]))[0]

    async def accept(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        proposal_id: UUID,
        *,
        concept_id: str | None,
        overrides: Mapping[str, Any],
        label_kind: str | None,
        language_code: str | None,
    ) -> ProposalRecord:
        """AcceptConceptProposal: OPEN → ACCEPTED, creating the draft concept or the label."""
        await authorize(ctx, workspace_id, "conceptProposals.decide", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            proposal = await self._load(session, workspace_id, proposal_id, for_update=True)
            self._require_open(proposal)
            scheme = await session.get(ConceptScheme, proposal.scheme_id, with_for_update=True)
            assert scheme is not None
            index = await SchemeIndex.load(session, scheme)
            if proposal.kind == "new_concept":
                if not concept_id or not is_code(concept_id):
                    raise InvalidArgument.for_field("conceptId", "conceptId (^[a-z][a-z0-9-]{0,62}$) is required.")
                changes: dict[str, Any] = {"prefLabels": [("vi", proposal.proposal_name)]}
                if proposal.definition:
                    changes["definition"] = proposal.definition
                if proposal.broader_concept_id is not None:
                    parent = await session.get(Concept, proposal.broader_concept_id)
                    if parent is not None:
                        changes["broader"] = [parent.notation]
                for path, value in overrides.items():
                    if path in ("broader", "related"):
                        notations = []
                        for position, name in enumerate(value):
                            code, notation = parse_concept(name, workspace_id, field=f"concept.{path}[{position}]")
                            if code != scheme.code:
                                raise InvalidArgument.for_field(
                                    f"concept.{path}[{position}]", "Name a concept of the proposal's scheme."
                                )
                            notations.append(notation)
                        value = notations
                    changes[path] = value
                concept = await ConceptService.insert(session, ctx, scheme, concept_id, changes, index=index)
                proposal.concept_id = concept.id
            else:
                if label_kind not in (None, "alt", "hidden"):
                    raise InvalidArgument.for_field("labelKind", "ALT or HIDDEN.")
                target = await session.get(Concept, proposal.target_concept_id, with_for_update=True)
                if target is None or target.deleted_at is not None or target.state == "deprecated":
                    raise FailedPrecondition("The target concept is no longer live.")
                current = (await concept_views(session, scheme, [target]))[target.id]
                path = "hiddenLabels" if label_kind == "hidden" else "altLabels"
                existing = list(current.hidden_labels if label_kind == "hidden" else current.alt_labels)
                await write_concept(
                    session,
                    index,
                    target,
                    {path: [*existing, (language_code or "vi", proposal.proposal_name)]},
                    current=current,
                )
            proposal.state = "accepted"
            proposal.decided_by_user_id = ctx.user_id
            proposal.decided_at = await now(session)
            await session.flush()
            record = (await proposal_records(session, ctx, workspace_id, [proposal]))[0]
            await audit(
                session,
                ctx,
                workspace_id,
                "AcceptConceptProposal",
                record.name,
                details={"concept": record.concept or record.target_concept},
            )
            return record

    async def reject(self, ctx: RequestContext, workspace_id: UUID, proposal_id: UUID) -> ProposalRecord:
        await authorize(ctx, workspace_id, "conceptProposals.decide", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            proposal = await self._load(session, workspace_id, proposal_id, for_update=True)
            self._require_open(proposal)
            proposal.state = "rejected"
            proposal.decided_by_user_id = ctx.user_id
            proposal.decided_at = await now(session)
            await session.flush()
            record = (await proposal_records(session, ctx, workspace_id, [proposal]))[0]
            await audit(session, ctx, workspace_id, "RejectConceptProposal", record.name)
            return record

    @staticmethod
    def _require_open(proposal: ConceptProposal) -> None:
        if proposal.state != "open":
            raise FailedPrecondition(f"The proposal is {proposal.state.upper()}, not OPEN.")

    @staticmethod
    async def _load(
        session: AsyncSession, workspace_id: UUID, proposal_id: UUID, *, for_update: bool = False
    ) -> ConceptProposal:
        statement = select(ConceptProposal).where(
            ConceptProposal.tenant_id == workspace_id, ConceptProposal.id == proposal_id
        )
        if for_update:
            statement = statement.with_for_update()
        proposal = await session.scalar(statement)
        if proposal is None:
            raise NotFound(f"'{proposal_name(workspace_id, proposal_id)}' does not exist.")
        return proposal


__all__ = ["ProposalService", "proposal_records"]
