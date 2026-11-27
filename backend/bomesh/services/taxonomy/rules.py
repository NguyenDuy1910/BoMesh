"""Concept rules: when a concept, collection or source holds, imply or favor a concept.

Rules are not versioned; every change is audited and, after commit, the
rule-derived assignments of the documents the old or the new condition matches
are re-evaluated (``reclassify.reevaluate_rules``, no model call). ``then`` is a
concept of a classification scheme; an IMPLIES rule must name an assignable
concept (published, and not a top concept when the scheme does not assign
them), a PRIOR rule may name any of its concepts (the prior spreads over its
published subtree).
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag as etags
from bomesh.db.engine import transaction_scope
from bomesh.db.models import IngestionSource, Item
from bomesh.db.models.taxonomy import Concept, ConceptRelation, ConceptRule, ConceptScheme
from bomesh.errors import AlreadyExists, InvalidArgument, NotFound
from bomesh.services.ingestion.names import source_codes, source_name
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.knowledge_items.names import item_name
from bomesh.services.taxonomy.names import concept_name, is_code, parse_concept, rule_name
from bomesh.services.taxonomy.records import RuleDraft, RuleRecord
from bomesh.services.taxonomy.support import TaxonomyDeps, audit, authorize, now

_log = logging.getLogger(__name__)
RULE_EFFECTS_API = ("implies", "prior")


def rule_etag(workspace_id: UUID, rule: ConceptRule) -> str:
    state = "|".join(
        str(value)
        for value in (
            rule.when_concept_id,
            rule.when_collection_item_id,
            rule.when_ingestion_source_id,
            rule.then_concept_id,
            rule.effect,
            # Numeric(4, 3): the stored 0.400 and the written 0.4 are one weight.
            None if rule.weight is None else f"{float(rule.weight):.3f}",
            rule.deleted_at,
        )
    )
    digest = hashlib.sha256(state.encode()).hexdigest()[:16]
    return etags.compute(f"{rule_name(workspace_id, rule.code)}\n{digest}", rule.created_at)


def _conditions(rule: ConceptRule) -> dict[str, str]:
    """The rule's condition for ``reevaluate_rules(previous=…)``."""
    values = {
        "when_concept_id": rule.when_concept_id,
        "when_collection_item_id": rule.when_collection_item_id,
        "when_ingestion_source_id": rule.when_ingestion_source_id,
        "then_concept_id": rule.then_concept_id,
    }
    return {key: str(value) for key, value in values.items() if value is not None}


async def rule_records(
    session: AsyncSession, workspace_id: UUID, rules: Sequence[ConceptRule]
) -> list[RuleRecord]:
    concept_ids = {rule.then_concept_id for rule in rules} | {
        rule.when_concept_id for rule in rules if rule.when_concept_id
    }
    names: dict[UUID, str] = {}
    if concept_ids:
        for cid, notation, code in (
            await session.execute(
                select(Concept.id, Concept.notation, ConceptScheme.code)
                .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
                .where(Concept.id.in_(concept_ids))
            )
        ).tuples():
            names[cid] = concept_name(workspace_id, code, notation)
    sources = await source_codes(
        session, [rule.when_ingestion_source_id for rule in rules if rule.when_ingestion_source_id]
    )
    return [
        RuleRecord(
            name=rule_name(workspace_id, rule.code),
            when_concept=names.get(rule.when_concept_id) if rule.when_concept_id else None,
            when_collection=item_name(workspace_id, rule.when_collection_item_id)
            if rule.when_collection_item_id
            else None,
            when_source=source_name(workspace_id, sources[rule.when_ingestion_source_id])
            if rule.when_ingestion_source_id in sources
            else None,
            then=names[rule.then_concept_id],
            effect=rule.effect,
            weight=None if rule.weight is None else float(rule.weight),
            creator=f"workspaces/{workspace_id}/members/{rule.created_by_user_id}"
            if rule.created_by_user_id
            else None,
            create_time=rule.created_at,
            etag=rule_etag(workspace_id, rule),
        )
        for rule in rules
    ]


async def _concept(
    session: AsyncSession, workspace_id: UUID, name: str, field: str
) -> tuple[Concept, ConceptScheme]:
    code, notation = parse_concept(name, workspace_id, field=field)
    row = (
        await session.execute(
            select(Concept, ConceptScheme)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(
                ConceptScheme.tenant_id == workspace_id,
                ConceptScheme.code == code,
                ConceptScheme.deleted_at.is_(None),
                Concept.notation == notation,
                Concept.deleted_at.is_(None),
            )
        )
    ).first()
    if row is None:
        raise InvalidArgument.for_field(field, f"'{name}' is not a concept of this workspace.")
    return row[0], row[1]


async def _apply(
    session: AsyncSession, workspace_id: UUID, rule: ConceptRule, draft: RuleDraft, paths: Sequence[str]
) -> None:
    """Set the ``paths`` of ``draft`` on ``rule`` and validate the whole rule."""
    if "when" in paths:
        given = [
            value
            for value in (draft.when_concept, draft.when_collection_id, draft.when_source_code)
            if value is not None
        ]
        if len(given) != 1:
            raise InvalidArgument.for_field("when", "Exactly one of when.concept, when.collection, when.source.")
        rule.when_concept_id = rule.when_collection_item_id = rule.when_ingestion_source_id = None
        if draft.when_concept is not None:
            rule.when_concept_id = (await _concept(session, workspace_id, draft.when_concept, "when.concept"))[0].id
        elif draft.when_collection_id is not None:
            found = await session.scalar(
                select(Item.id).where(
                    Item.id == draft.when_collection_id,
                    Item.tenant_id == workspace_id,
                    Item.item_kind == "collection",
                    Item.deleted_at.is_(None),
                )
            )
            if found is None:
                raise InvalidArgument.for_field("when.collection", "Not a live collection of this workspace.")
            rule.when_collection_item_id = found
        else:
            found = await session.scalar(
                select(IngestionSource.id).where(
                    IngestionSource.tenant_id == workspace_id,
                    IngestionSource.code == draft.when_source_code,
                )
            )
            if found is None:
                raise InvalidArgument.for_field("when.source", "Not a source of this workspace.")
            rule.when_ingestion_source_id = found
    if "effect" in paths:
        effect = (draft.effect or "").lower()
        if effect not in RULE_EFFECTS_API:
            raise InvalidArgument.for_field("effect", "effect is IMPLIES or PRIOR.")
        rule.effect = effect
    if "weight" in paths:
        rule.weight = None if draft.weight is None else Decimal(str(round(float(draft.weight), 3)))
    if "then" in paths:
        if not draft.then:
            raise InvalidArgument.for_field("then", "then is required.")
        concept, scheme = await _concept(session, workspace_id, draft.then, "then")
        if scheme.purpose != "classification":
            raise InvalidArgument.for_field("then", "then is a concept of a classification scheme.")
        rule.then_concept_id = concept.id
    then = await session.get(Concept, rule.then_concept_id)
    scheme = await session.get(ConceptScheme, then.scheme_id) if then is not None else None
    if rule.effect == "implies":
        if rule.weight is not None:
            raise InvalidArgument.for_field("weight", "weight is for PRIOR rules only.")
        top = not await session.scalar(
            select(
                exists().where(
                    ConceptRelation.source_concept_id == rule.then_concept_id,
                    ConceptRelation.kind == "broader",
                )
            )
        )
        if then is None or then.state != "published" or (
            scheme is not None and not scheme.assign_top_concepts and top
        ):
            raise InvalidArgument.for_field("then", "An IMPLIES rule names an assignable published concept.")
    elif rule.weight is None or not 0 <= rule.weight <= 1:
        raise InvalidArgument.for_field("weight", "A PRIOR rule has a weight between 0 and 1.")
    if rule.when_concept_id is not None and rule.when_concept_id == rule.then_concept_id:
        raise InvalidArgument.for_field("then", "A rule cannot imply its own condition.")


class RuleService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> RuleService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        draft: RuleDraft,
        *,
        request_id: UUID | None = None,
    ) -> RuleRecord:
        await authorize(ctx, workspace_id, "conceptRules.create", write=True)
        if not is_code(code):
            raise InvalidArgument.for_field("conceptRuleId", "A rule ID matches ^[a-z][a-z0-9-]{0,62}$.")
        async with transaction_scope(self._deps.sessions) as session:
            idempotency = Idempotency(session, self._deps.request_hash_secret)
            key = None
            if request_id is not None:
                key = idempotency.key(
                    ctx.principal,
                    request_id,
                    method="CreateConceptRule",
                    parent=f"workspaces/{workspace_id}",
                    request={
                        "conceptRuleId": code,
                        "when": [draft.when_concept, draft.when_collection_id, draft.when_source_code],
                        "then": draft.then,
                        "effect": draft.effect,
                        "weight": draft.weight,
                    },
                )
                replayed = await idempotency.replay(key)
                if replayed is not None:
                    rule = await self._load(session, workspace_id, replayed.rsplit("/", 1)[1])
                    return (await rule_records(session, workspace_id, [rule]))[0]
            taken = await session.scalar(
                select(ConceptRule.id).where(
                    ConceptRule.tenant_id == workspace_id,
                    ConceptRule.code == code,
                    ConceptRule.deleted_at.is_(None),
                )
            )
            if taken is not None:
                raise AlreadyExists(f"'{rule_name(workspace_id, code)}' already exists.")
            rule = ConceptRule(tenant_id=workspace_id, code=code, created_by_user_id=ctx.user_id)
            await _apply(session, workspace_id, rule, draft, ("when", "effect", "weight", "then"))
            session.add(rule)
            await session.flush()
            record = (await rule_records(session, workspace_id, [rule]))[0]
            await audit(session, ctx, workspace_id, "CreateConceptRule", record.name, after=_json(record))
            if key is not None:
                await idempotency.remember(key, record.name)
            rule_id = rule.id
        await self._reevaluate(ctx, workspace_id, [rule_id], ())
        return record

    async def get(self, ctx: RequestContext, workspace_id: UUID, code: str) -> RuleRecord:
        await authorize(ctx, workspace_id, "conceptRules.get", write=False)
        async with transaction_scope(self._deps.sessions) as session:
            rule = await self._load(session, workspace_id, code)
            return (await rule_records(session, workspace_id, [rule]))[0]

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, query: ListQuery
    ) -> tuple[list[RuleRecord], int]:
        await authorize(ctx, workspace_id, "conceptRules.list", write=False)
        statement = select(ConceptRule).where(
            ConceptRule.tenant_id == workspace_id, ConceptRule.deleted_at.is_(None)
        )
        async with transaction_scope(self._deps.sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rules = list(await session.scalars(query.apply(statement)))
            return await rule_records(session, workspace_id, rules), total

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        draft: RuleDraft,
        paths: Sequence[str],
        *,
        etag: str | None,
    ) -> RuleRecord:
        await authorize(ctx, workspace_id, "conceptRules.update", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            rule = await self._load(session, workspace_id, code, for_update=True)
            etags.check(etag, rule_etag(workspace_id, rule))
            before = (await rule_records(session, workspace_id, [rule]))[0]
            previous = _conditions(rule)
            await _apply(session, workspace_id, rule, draft, paths)
            await session.flush()
            record = (await rule_records(session, workspace_id, [rule]))[0]
            await audit(
                session, ctx, workspace_id, "UpdateConceptRule", record.name, before=_json(before), after=_json(record)
            )
            rule_id = rule.id
        await self._reevaluate(ctx, workspace_id, [rule_id], [previous])
        return record

    async def delete(self, ctx: RequestContext, workspace_id: UUID, code: str, *, etag: str | None) -> None:
        await authorize(ctx, workspace_id, "conceptRules.delete", write=True)
        async with transaction_scope(self._deps.sessions) as session:
            rule = await self._load(session, workspace_id, code, for_update=True)
            etags.check(etag, rule_etag(workspace_id, rule))
            before = (await rule_records(session, workspace_id, [rule]))[0]
            previous = _conditions(rule)
            rule.deleted_at = await now(session)
            await session.flush()
            await audit(session, ctx, workspace_id, "DeleteConceptRule", before.name, before=_json(before))
            rule_id = rule.id
        await self._reevaluate(ctx, workspace_id, [rule_id], [previous])

    @staticmethod
    async def _load(
        session: AsyncSession, workspace_id: UUID, code: str, *, for_update: bool = False
    ) -> ConceptRule:
        statement = select(ConceptRule).where(
            ConceptRule.tenant_id == workspace_id,
            ConceptRule.code == code,
            ConceptRule.deleted_at.is_(None),
        )
        if for_update:
            statement = statement.with_for_update()
        rule = await session.scalar(statement)
        if rule is None:
            raise NotFound(f"'{rule_name(workspace_id, code)}' does not exist.")
        return rule

    async def _reevaluate(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        rule_ids: Sequence[UUID],
        previous: Sequence[Mapping[str, str]],
    ) -> None:
        from bomesh.services.taxonomy import reclassify  # Reclassify slice

        try:
            await reclassify.reevaluate_rules(self._deps.runtime, ctx, workspace_id, rule_ids, previous)
        except Exception:
            # The rule change is committed; the next classification applies it.
            _log.exception("re-evaluating concept rules %s failed", list(rule_ids))


def _json(record: RuleRecord) -> dict[str, Any]:
    return {
        "when": {
            "concept": record.when_concept,
            "collection": record.when_collection,
            "source": record.when_source,
        },
        "then": record.then,
        "effect": record.effect,
        "weight": record.weight,
    }


__all__ = ["RuleService", "rule_etag", "rule_records"]
