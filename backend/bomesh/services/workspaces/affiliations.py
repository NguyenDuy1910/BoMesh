"""Member affiliations (``Member.affiliation``): the org units and programs a member
belongs to, with their cohort (entry year).

Personal data (``auth_contract.md``): only the member and holders of
``members.update`` read it. Members never self-declare it: an admin edits it
(UpdateMember, source ``admin``) or a registrar list imports it
(ImportMemberAffiliations, source ``directory``), and a directory import never
overwrites an admin edit. The rows of one member share their cohort and source.
Search ranking and applicability read it (``conversation_loop.md`` "Knowledge retrieval"); ending the
membership removes it.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import and_, delete, func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import (
    Concept,
    ConceptMapping,
    ConceptScheme,
    MemberAffiliation,
    TenantMembership,
    User,
)
from bomesh.errors import FieldViolation, InvalidArgument
from bomesh.iam.authorizer import WorkspaceRef
from bomesh.services.kernel.context import RequestContext
from bomesh.services.taxonomy.authority import ORG_UNIT_SCHEME, PROGRAM_SCHEME
from bomesh.services.taxonomy.names import concept_name, is_code, parse_concept
from bomesh.services.workspaces.records import Affiliation

#: Edit or import affiliations, and read every member's.
AFFILIATION_PERMISSION = "members.update"
MAX_IMPORT_ROWS = 5000
COHORT_MIN, COHORT_MAX = 1900, 2100

_KINDS = {ORG_UNIT_SCHEME: "org unit", PROGRAM_SCHEME: "program"}


@dataclass(frozen=True, slots=True)
class AuthorityConcept:
    """A published concept of the workspace's ``org-unit`` or ``program`` scheme."""

    id: UUID
    scheme_code: str
    notation: str


@dataclass(frozen=True, slots=True)
class Assignment:
    """The affiliation rows one member gets: concepts sharing a cohort."""

    concepts: tuple[AuthorityConcept, ...]
    cohort: int | None


@dataclass(frozen=True, slots=True)
class ImportRow:
    """One registrar-list row: ``program``/``unit`` are notations, concept names or
    (program only) the code of an exact mapping such as a MOET program code."""

    email: str
    program: str | None = None
    unit: str | None = None
    cohort: int | None = None


@dataclass(frozen=True, slots=True)
class ImportPlan:
    """The members named by an import, in row order, and what each gets."""

    assignments: dict[UUID, Assignment]
    #: Members whose affiliation an admin set: left untouched.
    skipped: tuple[UUID, ...]

    @property
    def written(self) -> list[UUID]:
        return [user_id for user_id in self.assignments if user_id not in self.skipped]


# -- Reads ----------------------------------------------------------------------


async def reads_every_affiliation(ctx: RequestContext, workspace_id: UUID) -> bool:
    """Whether the caller may read every member's affiliation (``members.update``)."""
    held = await ctx.authorizer.permissions(ctx.principal, WorkspaceRef(workspace_id))
    return AFFILIATION_PERMISSION in held


async def affiliations_of(
    session: AsyncSession, workspace_id: UUID, user_ids: Iterable[UUID]
) -> dict[UUID, Affiliation]:
    """The affiliation of each of ``user_ids`` (an empty one without rows), one query."""
    ids = list(dict.fromkeys(user_ids))
    if not ids:
        return {}
    rows = await session.execute(
        select(
            MemberAffiliation.user_id,
            MemberAffiliation.concept_id,
            MemberAffiliation.cohort,
            MemberAffiliation.source,
            ConceptScheme.code,
            Concept.notation,
        )
        .join(Concept, Concept.id == MemberAffiliation.concept_id)
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(MemberAffiliation.tenant_id == workspace_id, MemberAffiliation.user_id.in_(ids))
        .order_by(ConceptScheme.code, Concept.notation)
    )
    grouped: dict[UUID, list[AuthorityConcept]] = defaultdict(list)
    cohorts: dict[UUID, int | None] = {}
    admin: set[UUID] = set()
    for user_id, concept_id, cohort, source, scheme_code, notation in rows:
        grouped[user_id].append(AuthorityConcept(concept_id, scheme_code, notation))
        if cohort is not None:
            cohorts[user_id] = cohort
        if source == "admin":
            admin.add(user_id)
    return {
        user_id: affiliation(
            workspace_id,
            grouped.get(user_id, ()),
            cohorts.get(user_id),
            ("admin" if user_id in admin else "directory") if user_id in grouped else None,
        )
        for user_id in ids
    }


def affiliation(
    workspace_id: UUID,
    concepts: Iterable[AuthorityConcept],
    cohort: int | None,
    source: str | None,
) -> Affiliation:
    concepts = list(concepts)

    def names(scheme_code: str) -> tuple[str, ...]:
        return tuple(
            sorted(
                concept_name(workspace_id, concept.scheme_code, concept.notation)
                for concept in concepts
                if concept.scheme_code == scheme_code
            )
        )

    return Affiliation(
        units=names(ORG_UNIT_SCHEME),
        programs=names(PROGRAM_SCHEME),
        cohort=cohort if concepts else None,
        source=source if concepts else None,
    )


def audit_details(value: Affiliation) -> dict[str, object]:
    return {"units": list(value.units), "programs": list(value.programs), "cohort": value.cohort}


# -- Validation -----------------------------------------------------------------


def _authority_concepts():
    """Published concepts of the workspace's published ``org-unit``/``program`` schemes."""
    return (
        select(Concept.id, ConceptScheme.code, Concept.notation)
        .join(ConceptScheme, ConceptScheme.id == Concept.scheme_id)
        .where(
            ConceptScheme.code.in_((ORG_UNIT_SCHEME, PROGRAM_SCHEME)),
            ConceptScheme.purpose == "authority",
            ConceptScheme.deleted_at.is_(None),
            ConceptScheme.published_version.is_not(None),
            Concept.state == "published",
        )
    )


def _cohort_violation(cohort: int | None, field: str) -> FieldViolation | None:
    if cohort is not None and not COHORT_MIN <= cohort <= COHORT_MAX:
        return FieldViolation(field, f"cohort must be between {COHORT_MIN} and {COHORT_MAX}.")
    return None


def _unknown(value: str, scheme_code: str) -> str:
    return f"'{value}' is not a published {_KINDS[scheme_code]} concept of this workspace."


async def resolve_update(
    session: AsyncSession,
    workspace_id: UUID,
    *,
    units: Sequence[str],
    programs: Sequence[str],
    cohort: int | None,
) -> Assignment:
    """UpdateMember's ``affiliation``: concept names of each authority scheme, a cohort
    only with a concept. INVALID_ARGUMENT names every bad field."""
    violations: list[FieldViolation] = []
    wanted: dict[tuple[str, str], list[str]] = defaultdict(list)
    for column, scheme_code, values in (
        ("units", ORG_UNIT_SCHEME, units),
        ("programs", PROGRAM_SCHEME, programs),
    ):
        for index, value in enumerate(values):
            field = f"affiliation.{column}[{index}]"
            try:
                parsed = parse_concept(value, workspace_id, field=field)
            except InvalidArgument as exc:
                violations.extend(exc.field_violations)
                continue
            if parsed[0] != scheme_code:
                violations.append(FieldViolation(field, _unknown(value, scheme_code)))
                continue
            wanted[parsed].append(field)
    found: dict[tuple[str, str], AuthorityConcept] = {}
    if wanted:
        rows = await session.execute(
            _authority_concepts().where(
                ConceptScheme.tenant_id == workspace_id,
                Concept.notation.in_({notation for _, notation in wanted}),
            )
        )
        found = {(code, notation): AuthorityConcept(id_, code, notation) for id_, code, notation in rows}
    for key, fields in wanted.items():
        if key not in found:
            name = concept_name(workspace_id, *key)
            violations.extend(FieldViolation(field, _unknown(name, key[0])) for field in fields)
    if (violation := _cohort_violation(cohort, "affiliation.cohort")) is not None:
        violations.append(violation)
    elif cohort is not None and not wanted:
        violations.append(
            FieldViolation("affiliation.cohort", "A cohort needs at least one unit or program.")
        )
    if violations:
        raise InvalidArgument("The affiliation is invalid.", field_violations=violations)
    return Assignment(tuple(found[key] for key in wanted), cohort)


async def plan_import(
    session: AsyncSession,
    workspace_id: UUID,
    rows: Sequence[ImportRow],
    *,
    lock: bool,
) -> ImportPlan:
    """Validate a whole import (atomic: any bad row → INVALID_ARGUMENT naming
    ``rows[i].field``) in three bounded queries: members by email, concepts, admin edits.

    ``lock`` takes the named memberships FOR UPDATE (the writes that follow).
    """
    if not rows:
        raise InvalidArgument.for_field("rows", "rows is required.")
    if len(rows) > MAX_IMPORT_ROWS:
        raise InvalidArgument.for_field(
            "rows", f"An import takes at most {MAX_IMPORT_ROWS} rows; got {len(rows)}."
        )
    members = await _members_by_email(
        session, workspace_id, {row.email.strip().lower() for row in rows if row.email.strip()}, lock
    )
    by_notation, by_mapping = await _import_concepts(session, workspace_id, rows)

    violations: list[FieldViolation] = []
    concepts: dict[UUID, dict[UUID, AuthorityConcept]] = {}
    cohorts: dict[UUID, tuple[int, int]] = {}
    for index, row in enumerate(rows):
        prefix = f"rows[{index}]"
        email = row.email.strip().lower()
        user_id = members.get(email)
        if not email:
            violations.append(FieldViolation(f"{prefix}.email", "email is required."))
        elif user_id is None:
            violations.append(
                FieldViolation(f"{prefix}.email", f"No member of this workspace has the email '{row.email}'.")
            )
        found: list[AuthorityConcept] = []
        given = False
        for column, scheme_code, value in (
            ("program", PROGRAM_SCHEME, row.program),
            ("unit", ORG_UNIT_SCHEME, row.unit),
        ):
            value = (value or "").strip()
            if not value:
                continue
            given = True
            concept, problem = _resolve_import_value(
                workspace_id, scheme_code, value, by_notation, by_mapping
            )
            if concept is None:
                violations.append(FieldViolation(f"{prefix}.{column}", problem))
            else:
                found.append(concept)
        if not given:
            violations.append(
                FieldViolation(f"{prefix}.program", "A row needs a program or a unit.")
            )
        if (violation := _cohort_violation(row.cohort, f"{prefix}.cohort")) is not None:
            violations.append(violation)
        elif row.cohort is not None and user_id is not None:
            earlier = cohorts.setdefault(user_id, (row.cohort, index))
            if earlier[0] != row.cohort:
                violations.append(
                    FieldViolation(
                        f"{prefix}.cohort",
                        f"cohort {row.cohort} conflicts with rows[{earlier[1]}].cohort "
                        f"{earlier[0]} for the same member.",
                    )
                )
        if user_id is not None:
            bucket = concepts.setdefault(user_id, {})
            for concept in found:
                bucket[concept.id] = concept
    if violations:
        raise InvalidArgument("The import has invalid rows; nothing was imported.", field_violations=violations)

    assignments = {
        user_id: Assignment(
            tuple(found.values()), cohorts[user_id][0] if user_id in cohorts else None
        )
        for user_id, found in concepts.items()
    }
    admin = set(
        await session.scalars(
            select(MemberAffiliation.user_id)
            .where(
                MemberAffiliation.tenant_id == workspace_id,
                MemberAffiliation.user_id.in_(list(assignments)),
                MemberAffiliation.source == "admin",
            )
            .distinct()
        )
    )
    return ImportPlan(
        assignments, tuple(user_id for user_id in assignments if user_id in admin)
    )


async def _members_by_email(
    session: AsyncSession, workspace_id: UUID, emails: set[str], lock: bool
) -> dict[str, UUID]:
    """Live members of the workspace by lowercased email."""
    if not emails:
        return {}
    statement = (
        select(func.lower(User.email), TenantMembership.user_id)
        .join(User, User.id == TenantMembership.user_id)
        .where(
            TenantMembership.tenant_id == workspace_id,
            TenantMembership.deleted_at.is_(None),
            func.lower(User.email).in_(emails),
        )
    )
    if lock:
        statement = statement.with_for_update(of=TenantMembership)
    return {email: user_id for email, user_id in await session.execute(statement)}


async def _import_concepts(
    session: AsyncSession, workspace_id: UUID, rows: Sequence[ImportRow]
) -> tuple[dict[tuple[str, str], AuthorityConcept], dict[str, list[AuthorityConcept]]]:
    """The concepts an import may name, in one query: by ``(scheme, notation)`` and
    programs by the code of an ``exact`` mapping."""
    notations: set[str] = set()
    codes: set[str] = set()
    for row in rows:
        for value, is_program in ((row.program, True), (row.unit, False)):
            value = (value or "").strip()
            if not value:
                continue
            if "/" in value:
                notations.add(value.rsplit("/", 1)[-1])
            else:
                notations.add(value)
                if is_program:
                    codes.add(value)
    if not notations:
        return {}, {}
    mapping = and_(
        ConceptMapping.concept_id == Concept.id,
        ConceptMapping.match_type == "exact",
        ConceptMapping.target_code.in_(codes),
        ConceptScheme.code == PROGRAM_SCHEME,
    )
    result = await session.execute(
        _authority_concepts()
        .add_columns(ConceptMapping.target_code)
        .outerjoin(ConceptMapping, mapping)
        .where(
            ConceptScheme.tenant_id == workspace_id,
            or_(Concept.notation.in_(notations), ConceptMapping.target_code.is_not(None)),
        )
    )
    by_notation: dict[tuple[str, str], AuthorityConcept] = {}
    by_mapping: dict[str, dict[UUID, AuthorityConcept]] = defaultdict(dict)
    for id_, scheme_code, notation, target_code in result:
        concept = AuthorityConcept(id_, scheme_code, notation)
        by_notation[(scheme_code, notation)] = concept
        if target_code is not None:
            by_mapping[target_code][id_] = concept
    return by_notation, {code: list(found.values()) for code, found in by_mapping.items()}


def _resolve_import_value(
    workspace_id: UUID,
    scheme_code: str,
    value: str,
    by_notation: Mapping[tuple[str, str], AuthorityConcept],
    by_mapping: Mapping[str, list[AuthorityConcept]],
) -> tuple[AuthorityConcept | None, str]:
    if "/" in value:
        try:
            parsed = parse_concept(value, workspace_id, field="value")
        except InvalidArgument:
            return None, f"'{value}' is not a concept name of this workspace."
        if parsed[0] != scheme_code or parsed not in by_notation:
            return None, _unknown(value, scheme_code)
        return by_notation[parsed], ""
    if is_code(value) and (scheme_code, value) in by_notation:
        return by_notation[(scheme_code, value)], ""
    if scheme_code == PROGRAM_SCHEME:
        mapped = by_mapping.get(value, ())
        if len(mapped) == 1:
            return mapped[0], ""
        if len(mapped) > 1:
            notations = ", ".join(sorted(concept.notation for concept in mapped))
            return None, f"'{value}' is the code of several programs ({notations}); give the notation."
    return None, _unknown(value, scheme_code)


# -- Writes ---------------------------------------------------------------------


async def replace_affiliations(
    session: AsyncSession,
    workspace_id: UUID,
    assignments: Mapping[UUID, Assignment],
    *,
    source: str,
    updated_by: UUID,
) -> None:
    """Replace the rows of each member in ``assignments`` (no concepts: cleared)."""
    if not assignments:
        return
    await remove_affiliations(session, workspace_id, assignments)
    values = [
        {
            "tenant_id": workspace_id,
            "user_id": user_id,
            "concept_id": concept.id,
            "cohort": assignment.cohort,
            "source": source,
            "updated_by_user_id": updated_by,
        }
        for user_id, assignment in assignments.items()
        for concept in assignment.concepts
    ]
    if values:
        await session.execute(insert(MemberAffiliation), values)


async def remove_affiliations(
    session: AsyncSession, workspace_id: UUID, user_ids: Iterable[UUID]
) -> None:
    await session.execute(
        delete(MemberAffiliation).where(
            MemberAffiliation.tenant_id == workspace_id,
            MemberAffiliation.user_id.in_(list(user_ids)),
        )
    )


__all__ = [
    "AFFILIATION_PERMISSION",
    "COHORT_MAX",
    "COHORT_MIN",
    "MAX_IMPORT_ROWS",
    "Assignment",
    "AuthorityConcept",
    "ImportPlan",
    "ImportRow",
    "affiliation",
    "affiliations_of",
    "audit_details",
    "plan_import",
    "reads_every_affiliation",
    "remove_affiliations",
    "replace_affiliations",
    "resolve_update",
]
