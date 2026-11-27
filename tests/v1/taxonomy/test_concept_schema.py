"""The taxonomy schema refuses invalid concepts, graphs and assignments (invariants I1–I11).

Raw ORM writes, no service in between: the rules live in CHECKs, unique
indexes and triggers (``bomesh.db.models.triggers``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import update
from sqlalchemy.exc import DBAPIError

from bomesh.db.models import (
    Concept,
    ConceptLabel,
    ConceptRelation,
    ConceptScheme,
    Item,
    ItemConcept,
    Tenant,
)
from bomesh.services.taxonomy.normalize import normalize_label
from harness import Sessions

pytestmark = pytest.mark.asyncio


async def _add(sessions: Sessions, *rows: Any) -> None:
    async with sessions.begin() as session:
        for row in rows:
            session.add(row)
            await session.flush()


async def _rejected(sessions: Sessions, *rows: Any, match: str) -> None:
    with pytest.raises(DBAPIError, match=match):
        await _add(sessions, *rows)


async def _tenant(sessions: Sessions) -> UUID:
    tenant = Tenant(code=f"t-{uuid4().hex[:12]}", tenant_name="Workspace")
    await _add(sessions, tenant)
    return tenant.id


async def _scheme(
    sessions: Sessions, tenant_id: UUID | None, *, purpose: str = "classification", **values: Any
) -> ConceptScheme:
    scheme = ConceptScheme(
        id=uuid4(),
        tenant_id=tenant_id,
        code=values.pop("code", f"s-{uuid4().hex[:8]}"),
        scheme_name="Scheme",
        purpose=purpose,
        max_depth=3,
        llm_policy="always" if purpose == "classification" else "never",
        **values,
    )
    await _add(sessions, scheme)
    return scheme


def _concept(scheme: ConceptScheme, notation: str, state: str = "published", **values: Any) -> Concept:
    return Concept(
        id=uuid4(),
        tenant_id=scheme.tenant_id,
        scheme_id=scheme.id,
        notation=notation,
        state=state,
        first_version=None if state == "draft" else 1,
        **values,
    )


def _broader(source: Concept, target: Concept) -> ConceptRelation:
    return ConceptRelation(
        source_concept_id=source.id, target_concept_id=target.id, kind="broader"
    )


def _label(concept: Concept, kind: str, text: str, language: str = "vi") -> ConceptLabel:
    return ConceptLabel(
        concept_id=concept.id,
        kind=kind,
        language_code=language,
        label_text=text,
        normalized=normalize_label(text),
    )


async def _document(sessions: Sessions, tenant_id: UUID) -> UUID:
    collection = Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_kind="collection",
        item_type="standard",
        item_name="Collection",
        inherit_access=False,
        discoverable=False,
        accepts_contributions=False,
    )
    document = Item(
        id=uuid4(),
        tenant_id=tenant_id,
        item_kind="document",
        item_type="pdf",
        parent_item_id=collection.id,
        item_name="Document",
        is_published=True,
        purpose="knowledge",
    )
    await _add(sessions, collection, document)
    return document.id


def _label_row(
    item_id: UUID, concept: Concept, *, state: str = "accepted", primary: bool = False
) -> ItemConcept:
    return ItemConcept(
        item_id=item_id,
        concept_id=concept.id,
        scheme_id=concept.scheme_id,
        is_primary=primary,
        source="human",
        state=state,
    )


async def test_labels_one_pref_per_language_and_kinds_disjoint(sessions: Sessions) -> None:
    scheme = await _scheme(sessions, await _tenant(sessions))
    concept = _concept(scheme, "hoc-vu")
    await _add(sessions, concept, _label(concept, "pref", "Học vụ"))
    await _add(sessions, _label(concept, "pref", "Academic affairs", "en"))

    await _rejected(sessions, _label(concept, "pref", "Đào tạo"), match="uq_concept_labels_pref")
    await _rejected(
        sessions,
        _label(concept, "alt", "  học VỤ. "),
        match="uq_concept_labels_concept_id_language_code_normalized",
    )
    await _add(sessions, _label(concept, "hidden", "hoc vu"))


async def test_notation_is_immutable_and_never_reused(sessions: Sessions) -> None:
    scheme = await _scheme(sessions, await _tenant(sessions))
    concept = _concept(scheme, "draft-one", "draft")
    await _add(sessions, concept)

    with pytest.raises(DBAPIError, match="immutable"):
        async with sessions.begin() as session:
            await session.execute(
                update(Concept).where(Concept.id == concept.id).values(notation="renamed")
            )

    async with sessions.begin() as session:
        await session.execute(
            update(Concept)
            .where(Concept.id == concept.id)
            .values(deleted_at=datetime.now(UTC))
        )
    await _rejected(
        sessions, _concept(scheme, "draft-one", "draft"), match="uq_concepts_scheme_id_notation"
    )


async def test_broader_cycles_rejected_diamond_allowed(sessions: Sessions) -> None:
    scheme = await _scheme(sessions, await _tenant(sessions))
    top, middle, leaf, other = (
        _concept(scheme, notation) for notation in ("top", "middle", "leaf", "other")
    )
    await _add(sessions, top, middle, leaf, other)
    await _add(sessions, _broader(middle, top), _broader(leaf, middle), _broader(leaf, other))

    await _rejected(sessions, _broader(top, leaf), match="broader cycle")
    # Through the second parent: other → leaf would close leaf → other.
    await _rejected(sessions, _broader(other, leaf), match="broader cycle")

    # Diamond: two paths from one concept up to one ancestor.
    side = _concept(scheme, "side")
    await _add(sessions, side, _broader(side, top))
    await _add(sessions, _broader(other, top))


async def test_color_only_on_top_concepts(sessions: Sessions) -> None:
    scheme = await _scheme(sessions, await _tenant(sessions))
    top = _concept(scheme, "top", color="#aa0000")
    child = _concept(scheme, "child")
    await _add(sessions, top, child, _broader(child, top))

    with pytest.raises(DBAPIError, match="only a top Concept has a color"):
        async with sessions.begin() as session:
            await session.execute(
                update(Concept).where(Concept.id == child.id).values(color="#00aa00")
            )
    colored = _concept(scheme, "colored", color="#0000aa")
    await _add(sessions, colored)
    await _rejected(sessions, _broader(colored, top), match="only a top Concept has a color")


async def test_tenant_concept_never_joins_a_template_scheme(sessions: Sessions) -> None:
    tenant_id = await _tenant(sessions)
    template = await _scheme(sessions, None)
    stray = _concept(template, "stray")
    stray.tenant_id = tenant_id
    await _rejected(sessions, stray, match="Concept Scheme of its tenant")

    template_concept = _concept(template, "base")
    await _add(sessions, template_concept)
    fork = await _scheme(sessions, tenant_id, template_scheme_id=template.id)
    await _add(sessions, _concept(fork, "base", template_concept_id=template_concept.id))


async def test_item_concepts_target_published_assignable_classification_concepts(
    sessions: Sessions,
) -> None:
    tenant_id = await _tenant(sessions)
    item_id = await _document(sessions, tenant_id)
    scheme = await _scheme(sessions, tenant_id, assign_top_concepts=False)
    authority = await _scheme(sessions, tenant_id, purpose="authority")
    top = _concept(scheme, "top")
    leaf = _concept(scheme, "leaf")
    draft = _concept(scheme, "draft", "draft")
    deprecated = _concept(scheme, "old", "deprecated", deprecated_version=2)
    unit = _concept(authority, "unit")
    await _add(sessions, top, leaf, draft, deprecated, unit)
    await _add(sessions, _broader(leaf, top), _broader(draft, top), _broader(deprecated, top))

    await _rejected(sessions, _label_row(item_id, draft), match="published Concept")
    await _rejected(sessions, _label_row(item_id, deprecated), match="published Concept")
    await _rejected(sessions, _label_row(item_id, unit), match="classification scheme")
    await _rejected(sessions, _label_row(item_id, top), match="top Concepts")
    await _add(sessions, _label_row(item_id, leaf))


async def test_item_concept_cardinality_checked_at_commit(sessions: Sessions) -> None:
    tenant_id = await _tenant(sessions)
    item_id = await _document(sessions, tenant_id)
    scheme = await _scheme(sessions, tenant_id, max_labels=2, has_primary=True)
    first, second, third = (_concept(scheme, notation) for notation in ("a", "b", "c"))
    await _add(sessions, first, second, third)

    # Every row flushes; the commit refuses the set.
    with pytest.raises(DBAPIError, match="max_labels"):
        async with sessions.begin() as session:
            session.add_all(
                [
                    _label_row(item_id, first, primary=True),
                    _label_row(item_id, second),
                    _label_row(item_id, third),
                ]
            )
            await session.flush()
    await _rejected(
        sessions,
        _label_row(item_id, first),
        _label_row(item_id, second),
        match="exactly one primary",
    )
    # A suggestion does not count; one primary among accepted rows commits.
    await _add(
        sessions,
        _label_row(item_id, first),
        _label_row(item_id, second, primary=True),
        _label_row(item_id, third, state="suggested"),
    )
