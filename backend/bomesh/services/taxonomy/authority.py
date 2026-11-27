"""Authority schemes: the org-unit and program Concepts that metadata and member
affiliations reference (never classification targets).

Applicability (``document.applicability``) and ``Member.affiliation`` split their
Concepts into units and programs by scheme code. A program names its faculty with a
``concept_mappings`` row (``target_system = org-unit``, ``target_code`` = the unit's
notation), since ``broader`` never crosses schemes.
"""

from __future__ import annotations

from uuid import UUID

from bomesh.services.taxonomy.snapshot import TaxonomySnapshot

ORG_UNIT_SCHEME = "org-unit"
PROGRAM_SCHEME = "program"
AUTHORITY_SCHEMES = (ORG_UNIT_SCHEME, PROGRAM_SCHEME)
#: An extracted applicability at or above this confidence is explicit
#: (``conversation_loop.md`` "Knowledge retrieval"): ranking may exclude another unit's document. A human-entered one always is.
APPLICABILITY_AUTO_THRESHOLD = 0.9


def program_faculties(taxonomy: TaxonomySnapshot, program_id: UUID) -> frozenset[UUID]:
    """The org-unit Concepts a program names as its faculty (``org-unit`` mappings)."""

    programs = taxonomy.schemes.get(PROGRAM_SCHEME)
    units = taxonomy.schemes.get(ORG_UNIT_SCHEME)
    if programs is None or units is None or program_id not in programs.concepts:
        return frozenset()
    by_notation = {concept.notation: concept.id for concept in units.concepts.values()}
    return frozenset(
        by_notation[code]
        for system, code, _label, _match in programs.concepts[program_id].mappings
        if system == ORG_UNIT_SCHEME and code in by_notation
    )


def program_units(taxonomy: TaxonomySnapshot, program_id: UUID) -> frozenset[UUID]:
    """A program's faculty units with their ancestors."""

    units = taxonomy.schemes.get(ORG_UNIT_SCHEME)
    found: set[UUID] = set()
    for unit in program_faculties(taxonomy, program_id):
        found.add(unit)
        if units is not None:
            found.update(units.ancestors(unit))
    return frozenset(found)


__all__ = [
    "APPLICABILITY_AUTO_THRESHOLD",
    "AUTHORITY_SCHEMES",
    "ORG_UNIT_SCHEME",
    "PROGRAM_SCHEME",
    "program_faculties",
    "program_units",
]
