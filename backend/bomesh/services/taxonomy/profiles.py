"""Typed issuance and applicability metadata of Documents (``document_profiles``).

The one writer of ``document_profiles``, ``document_applicability`` and
``document_supersessions``. Processing writes what it extracted
(:func:`write_extracted_profile`); people set issuance and applicability
(UpdateItem ``document.issuance`` / ``document.applicability``). A field a
person set is marked ``human`` in ``field_sources`` and extraction never
overwrites it (``document_contract.md`` "Processing").

Superseded documents are resolved by ``document_number`` among the tenant's
live documents (exact, then ignoring case and whitespace); a number not found
yet stays in ``unresolved_supersedes`` and is resolved when a document with
that number gets its profile.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import Uuid, delete, func, literal, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    Concept,
    ConceptScheme,
    DocumentApplicability,
    DocumentProfile,
    DocumentSupersession,
    Item,
)
from bomesh.db.models.knowledge import APPLICABILITY_LEVELS
from bomesh.errors import InvalidArgument
from bomesh.services.taxonomy.authority import ORG_UNIT_SCHEME, PROGRAM_SCHEME

if TYPE_CHECKING:
    from bomesh.services.taxonomy.classification import ExtractedMetadata

ISSUANCE_FIELD = "document.issuance"
APPLICABILITY_FIELD = "document.applicability"
#: ``field_sources`` keys of :class:`IssuanceInput`.
ISSUANCE_SOURCES = (
    "issuer",
    "campus",
    "number",
    "issue_date",
    "effective_date",
    "supersedes",
)
_NUMBER_LENGTH = 128
_SPACES = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class IssuanceInput:
    """``document.issuance`` as a person sets it; ``supersedes`` are Document ids."""

    issuer_id: UUID | None = None
    campus_id: UUID | None = None
    number: str | None = None
    issued_on: date | None = None
    effective_on: date | None = None
    supersedes: tuple[UUID, ...] = ()


@dataclass(frozen=True, slots=True)
class ApplicabilityInput:
    """``document.applicability`` as a person sets it."""

    #: institution | unit | program | cohort; ``None`` = unknown.
    level: str | None = None
    unit_ids: tuple[UUID, ...] = ()
    program_ids: tuple[UUID, ...] = ()
    cohorts: tuple[int, ...] = ()


@dataclass(frozen=True, slots=True)
class ProfileRecord:
    """A Document's issuance and applicability as reads show them."""

    issuer_id: UUID | None
    campus_id: UUID | None
    number: str | None
    issued_on: date | None
    effective_on: date | None
    #: Live superseded Documents.
    supersedes: tuple[UUID, ...]
    level: str | None
    unit_ids: tuple[UUID, ...]
    program_ids: tuple[UUID, ...]
    cohorts: tuple[int, ...]
    applicability_confidence: float | None
    field_sources: Mapping[str, str] = field(default_factory=dict)


# ---- Processing ----------------------------------------------------------------


async def write_extracted_profile(
    session: AsyncSession,
    item_id: UUID,
    tenant_id: UUID,
    metadata: ExtractedMetadata,
    *,
    revision_number: int | None,
) -> None:
    """Write what classification extracted; human fields stay, others take the new values.

    A field the revision no longer yields is cleared (it described an older revision).
    """

    profile = await _profile(session, item_id)
    sources = dict(profile.field_sources or {})

    def writable(name: str, present: bool) -> bool:
        if sources.get(name) == "human":
            return False
        if present:
            sources[name] = "extracted"
        else:
            sources.pop(name, None)
        return True

    if writable("issuer", metadata.issuer_concept_id is not None):
        profile.issuer_concept_id = metadata.issuer_concept_id
    if writable("campus", metadata.campus_concept_id is not None):
        profile.campus_concept_id = metadata.campus_concept_id
    previous_number = profile.document_number
    if writable("number", metadata.number is not None):
        profile.document_number = (
            metadata.number[:_NUMBER_LENGTH] if metadata.number is not None else None
        )
    if writable("issue_date", metadata.issued_on is not None):
        profile.issued_on = metadata.issued_on
    if writable("effective_date", metadata.effective_on is not None):
        profile.effective_on = metadata.effective_on
    applies = bool(
        metadata.level or metadata.unit_ids or metadata.program_ids or metadata.cohorts
    )
    if writable("applicability", applies):
        profile.applicability_level = metadata.level
        profile.applicability_cohorts = sorted(set(metadata.cohorts))
        profile.applicability_confidence = (
            metadata.applicability_confidence if applies else None
        )
        await _replace_applicability(
            session, item_id, (*metadata.unit_ids, *metadata.program_ids)
        )
    if writable("supersedes", bool(metadata.supersedes)):
        await session.execute(
            delete(DocumentSupersession).where(
                DocumentSupersession.item_id == item_id,
                DocumentSupersession.source == "extracted",
            )
        )
        resolved, unresolved = await _resolve_numbers(
            session, tenant_id, item_id, metadata.supersedes
        )
        await _add_supersessions(session, item_id, resolved, source="extracted")
        profile.unresolved_supersedes = unresolved
    profile.field_sources = sources
    profile.revision_number = revision_number
    await session.flush()
    if profile.document_number and profile.document_number != previous_number:
        await _resolve_pending(session, tenant_id, item_id, profile.document_number)


# ---- People ---------------------------------------------------------------------


async def set_issuance(
    session: AsyncSession, item_id: UUID, tenant_id: UUID, issuance: IssuanceInput
) -> None:
    """UpdateItem ``document.issuance``: every issuance field becomes the person's.

    INVALID_ARGUMENT (``document.issuance.*``) on an issuer or campus outside
    the tenant's org-unit scheme, a number too long, or a superseded Document
    that is not a live document of the tenant (or the Document itself).
    """

    for name, concept_id in (
        ("issuer", issuance.issuer_id),
        ("campus", issuance.campus_id),
    ):
        if concept_id is not None and not await _authority(
            session, tenant_id, ORG_UNIT_SCHEME, (concept_id,)
        ):
            raise InvalidArgument.for_field(
                f"{ISSUANCE_FIELD}.{name}",
                f"The {name} must be a published org-unit concept.",
            )
    if issuance.number is not None and len(issuance.number) > _NUMBER_LENGTH:
        raise InvalidArgument.for_field(
            f"{ISSUANCE_FIELD}.number",
            f"The number is at most {_NUMBER_LENGTH} characters.",
        )
    superseded = tuple(dict.fromkeys(issuance.supersedes))
    if superseded:
        live = set(
            await session.scalars(
                select(Item.id).where(
                    Item.id.in_(superseded),
                    Item.tenant_id == tenant_id,
                    Item.item_kind == "document",
                    Item.deleted_at.is_(None),
                )
            )
        )
        if item_id in superseded or live != set(superseded):
            raise InvalidArgument.for_field(
                f"{ISSUANCE_FIELD}.supersedes",
                "Each superseded item must be another document of the workspace.",
            )
    profile = await _profile(session, item_id)
    previous_number = profile.document_number
    number = issuance.number.strip() if issuance.number else None
    profile.issuer_concept_id = issuance.issuer_id
    profile.campus_concept_id = issuance.campus_id
    profile.document_number = number or None
    profile.issued_on = issuance.issued_on
    profile.effective_on = issuance.effective_on
    profile.unresolved_supersedes = []
    profile.field_sources = {
        **(profile.field_sources or {}),
        **{name: "human" for name in ISSUANCE_SOURCES},
    }
    await session.execute(
        delete(DocumentSupersession).where(DocumentSupersession.item_id == item_id)
    )
    await _add_supersessions(session, item_id, superseded, source="human")
    await session.flush()
    if profile.document_number and profile.document_number != previous_number:
        await _resolve_pending(session, tenant_id, item_id, profile.document_number)


async def set_applicability(
    session: AsyncSession,
    item_id: UUID,
    tenant_id: UUID,
    applicability: ApplicabilityInput,
) -> None:
    """UpdateItem ``document.applicability``: the person's applicability (confidence 1)."""

    if (
        applicability.level is not None
        and applicability.level not in APPLICABILITY_LEVELS
    ):
        raise InvalidArgument.for_field(
            f"{APPLICABILITY_FIELD}.level",
            "The level is not a known applicability level.",
        )
    for name, scheme, ids in (
        ("units", ORG_UNIT_SCHEME, applicability.unit_ids),
        ("programs", PROGRAM_SCHEME, applicability.program_ids),
    ):
        wanted = set(ids)
        if wanted and await _authority(session, tenant_id, scheme, wanted) != wanted:
            raise InvalidArgument.for_field(
                f"{APPLICABILITY_FIELD}.{name}",
                f"Each of {name} must be a published {scheme} concept.",
            )
    if any(not 1900 <= cohort <= 2999 for cohort in applicability.cohorts):
        raise InvalidArgument.for_field(
            f"{APPLICABILITY_FIELD}.cohorts", "A cohort is an entry year such as 2022."
        )
    profile = await _profile(session, item_id)
    profile.applicability_level = applicability.level
    profile.applicability_cohorts = sorted(set(applicability.cohorts))
    profile.applicability_confidence = 1.0
    profile.field_sources = {**(profile.field_sources or {}), "applicability": "human"}
    await _replace_applicability(
        session, item_id, (*applicability.unit_ids, *applicability.program_ids)
    )
    await session.flush()


# ---- Reads and merges ---------------------------------------------------------------


async def profile_records(
    session: AsyncSession, item_ids: Iterable[UUID]
) -> dict[UUID, ProfileRecord]:
    """Issuance and applicability of each Document that has a profile."""

    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return {}
    profiles = list(
        await session.scalars(
            select(DocumentProfile).where(DocumentProfile.item_id.in_(ids))
        )
    )
    if not profiles:
        return {}
    applies: dict[UUID, dict[str, list[UUID]]] = defaultdict(lambda: defaultdict(list))
    for item_id, concept_id, code in (
        await session.execute(
            select(
                DocumentApplicability.item_id,
                DocumentApplicability.concept_id,
                ConceptScheme.code,
            )
            .join(Concept, Concept.id == DocumentApplicability.concept_id)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(DocumentApplicability.item_id.in_(ids))
            .order_by(DocumentApplicability.item_id, Concept.notation)
        )
    ).all():
        applies[item_id][code].append(concept_id)
    superseded: dict[UUID, list[UUID]] = defaultdict(list)
    for item_id, target in (
        await session.execute(
            select(
                DocumentSupersession.item_id, DocumentSupersession.superseded_item_id
            )
            .join(Item, Item.id == DocumentSupersession.superseded_item_id)
            .where(DocumentSupersession.item_id.in_(ids), Item.deleted_at.is_(None))
            .order_by(DocumentSupersession.item_id, DocumentSupersession.created_at)
        )
    ).all():
        superseded[item_id].append(target)
    return {
        profile.item_id: ProfileRecord(
            issuer_id=profile.issuer_concept_id,
            campus_id=profile.campus_concept_id,
            number=profile.document_number,
            issued_on=profile.issued_on,
            effective_on=profile.effective_on,
            supersedes=tuple(superseded.get(profile.item_id, ())),
            level=profile.applicability_level,
            unit_ids=tuple(applies[profile.item_id][ORG_UNIT_SCHEME]),
            program_ids=tuple(applies[profile.item_id][PROGRAM_SCHEME]),
            cohorts=tuple(profile.applicability_cohorts or ()),
            applicability_confidence=profile.applicability_confidence,
            field_sources=dict(profile.field_sources or {}),
        )
        for profile in profiles
    }


async def merge_profiles(
    session: AsyncSession, duplicate_id: UUID, survivor_id: UUID
) -> None:
    """MergeItem: the survivor keeps its profile (else takes the duplicate's), and
    supersessions naming the duplicate name the survivor."""

    duplicate = await session.get(DocumentProfile, duplicate_id, with_for_update=True)
    survivor = await session.get(DocumentProfile, survivor_id, with_for_update=True)
    if duplicate is not None and survivor is None:
        session.add(
            DocumentProfile(
                item_id=survivor_id,
                issuer_concept_id=duplicate.issuer_concept_id,
                campus_concept_id=duplicate.campus_concept_id,
                document_number=duplicate.document_number,
                issued_on=duplicate.issued_on,
                effective_on=duplicate.effective_on,
                applicability_level=duplicate.applicability_level,
                applicability_cohorts=list(duplicate.applicability_cohorts or ()),
                applicability_confidence=duplicate.applicability_confidence,
                field_sources=dict(duplicate.field_sources or {}),
                unresolved_supersedes=list(duplicate.unresolved_supersedes or ()),
                revision_number=duplicate.revision_number,
            )
        )
        await session.flush()
        await session.execute(
            pg_insert(DocumentApplicability)
            .from_select(
                ["item_id", "concept_id"],
                select(
                    literal(survivor_id, Uuid), DocumentApplicability.concept_id
                ).where(DocumentApplicability.item_id == duplicate_id),
            )
            .on_conflict_do_nothing()
        )
    for column, other in (
        (DocumentSupersession.item_id, DocumentSupersession.superseded_item_id),
        (DocumentSupersession.superseded_item_id, DocumentSupersession.item_id),
    ):
        moved = select(
            literal(survivor_id, Uuid).label("survivor"),
            other,
            DocumentSupersession.source,
        ).where(column == duplicate_id, other != survivor_id)
        names = (
            ["item_id", "superseded_item_id", "source"]
            if column is DocumentSupersession.item_id
            else ["superseded_item_id", "item_id", "source"]
        )
        await session.execute(
            pg_insert(DocumentSupersession)
            .from_select(names, moved)
            .on_conflict_do_nothing()
        )
    await session.execute(
        delete(DocumentSupersession).where(
            (DocumentSupersession.item_id == duplicate_id)
            | (DocumentSupersession.superseded_item_id == duplicate_id)
        )
    )
    await session.execute(
        delete(DocumentApplicability).where(
            DocumentApplicability.item_id == duplicate_id
        )
    )
    if duplicate is not None:
        await session.delete(duplicate)
    await session.flush()


# ---- Internals ---------------------------------------------------------------------


async def _profile(session: AsyncSession, item_id: UUID) -> DocumentProfile:
    """The Document's profile row, created empty when missing, locked for update."""

    await session.execute(
        pg_insert(DocumentProfile).values(item_id=item_id).on_conflict_do_nothing()
    )
    profile = await session.get(
        DocumentProfile, item_id, with_for_update=True, populate_existing=True
    )
    assert profile is not None
    return profile


async def _replace_applicability(
    session: AsyncSession, item_id: UUID, concept_ids: Sequence[UUID]
) -> None:
    await session.execute(
        delete(DocumentApplicability).where(DocumentApplicability.item_id == item_id)
    )
    for concept_id in dict.fromkeys(concept_ids):
        session.add(DocumentApplicability(item_id=item_id, concept_id=concept_id))
    await session.flush()


async def _add_supersessions(
    session: AsyncSession, item_id: UUID, superseded: Iterable[UUID], *, source: str
) -> None:
    for target in dict.fromkeys(superseded):
        if target != item_id:
            await session.execute(
                pg_insert(DocumentSupersession)
                .values(item_id=item_id, superseded_item_id=target, source=source)
                .on_conflict_do_nothing()
            )


async def _authority(
    session: AsyncSession, tenant_id: UUID, scheme_code: str, ids: Iterable[UUID]
) -> set[UUID]:
    """Those of ``ids`` that are published concepts of the tenant's authority scheme."""

    return set(
        await session.scalars(
            select(Concept.id)
            .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
            .where(
                Concept.id.in_(list(ids)),
                Concept.tenant_id == tenant_id,
                Concept.state == "published",
                Concept.deleted_at.is_(None),
                ConceptScheme.code == scheme_code,
                ConceptScheme.deleted_at.is_(None),
            )
        )
    )


def _number_key(number: str) -> str:
    return _SPACES.sub("", number).lower()


def _live_numbered(tenant_id: UUID, item_id: UUID):
    return (
        select(Item.id)
        .join(DocumentProfile, DocumentProfile.item_id == Item.id)
        .where(
            Item.tenant_id == tenant_id,
            Item.item_kind == "document",
            Item.deleted_at.is_(None),
            Item.id != item_id,
        )
    )


async def _resolve_numbers(
    session: AsyncSession, tenant_id: UUID, item_id: UUID, numbers: Sequence[str]
) -> tuple[list[UUID], list[str]]:
    """Documents with the printed numbers (exact, else ignoring case and whitespace)."""

    resolved: list[UUID] = []
    unresolved: list[str] = []
    for number in dict.fromkeys(numbers):
        found = list(
            await session.scalars(
                _live_numbered(tenant_id, item_id).where(
                    DocumentProfile.document_number == number
                )
            )
        )
        if not found:
            found = list(
                await session.scalars(
                    _live_numbered(tenant_id, item_id).where(
                        func.lower(
                            func.regexp_replace(
                                DocumentProfile.document_number, r"\s+", "", "g"
                            )
                        )
                        == _number_key(number)
                    )
                )
            )
        if found:
            resolved.extend(found)
        else:
            unresolved.append(number)
    return resolved, unresolved


async def _resolve_pending(
    session: AsyncSession, tenant_id: UUID, item_id: UUID, number: str
) -> None:
    """Other documents' unresolved references to ``number`` now name this Document."""

    key = _number_key(number)
    waiting = list(
        await session.scalars(
            select(DocumentProfile)
            .join(Item, Item.id == DocumentProfile.item_id)
            .where(
                Item.tenant_id == tenant_id,
                Item.deleted_at.is_(None),
                Item.id != item_id,
                func.cardinality(DocumentProfile.unresolved_supersedes) > 0,
            )
            .with_for_update(of=DocumentProfile)
        )
    )
    for profile in waiting:
        remaining = [
            ref for ref in profile.unresolved_supersedes if _number_key(ref) != key
        ]
        if len(remaining) == len(profile.unresolved_supersedes):
            continue
        await _add_supersessions(
            session, profile.item_id, (item_id,), source="extracted"
        )
        profile.unresolved_supersedes = remaining
    await session.flush()


__all__ = [
    "APPLICABILITY_FIELD",
    "ISSUANCE_FIELD",
    "ApplicabilityInput",
    "IssuanceInput",
    "ProfileRecord",
    "merge_profiles",
    "profile_records",
    "set_applicability",
    "set_issuance",
    "write_extracted_profile",
]
