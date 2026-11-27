"""``concept_closure``: ancestor/descendant pairs of a scheme's PUBLISHED broader graph."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models.taxonomy import Concept, ConceptClosure
from bomesh.services.taxonomy.snapshot import SchemeSnapshot

ClosureRow = tuple[UUID, UUID, int]


def closure_rows(snapshot: SchemeSnapshot) -> list[ClosureRow]:
    """(ancestor, descendant, shortest depth) of the published concepts, self rows included.

    Only edges between published concepts count; a concept reached through
    several parents keeps its shortest distance.
    """

    published = {
        cid: concept for cid, concept in snapshot.concepts.items() if concept.state == "published"
    }
    rows: list[ClosureRow] = []
    for cid in sorted(published, key=lambda key: published[key].notation):
        rows.append((cid, cid, 0))
        depth = 0
        frontier = [cid]
        seen = {cid}
        while frontier:
            depth += 1
            following = []
            for current in frontier:
                for parent in published[current].broader:
                    if parent in published and parent not in seen:
                        seen.add(parent)
                        following.append(parent)
                        rows.append((parent, cid, depth))
            frontier = following
    return rows


async def rebuild_closure(session: AsyncSession, scheme_id: UUID, snapshot: SchemeSnapshot) -> None:
    """Replace the scheme's closure rows with those of ``snapshot`` (publish transaction)."""

    await session.execute(
        delete(ConceptClosure).where(
            ConceptClosure.descendant_id.in_(
                select(Concept.id).where(Concept.scheme_id == scheme_id)
            )
        )
    )
    rows = closure_rows(snapshot)
    if rows:
        await session.execute(
            insert(ConceptClosure),
            [
                {"ancestor_id": ancestor, "descendant_id": descendant, "depth": depth}
                for ancestor, descendant, depth in rows
            ],
        )
