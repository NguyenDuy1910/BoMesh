"""ImportConcepts: create and update a scheme's concepts from spreadsheet rows (MERGE by notation).

Rows are the CSV cells the client parsed (``ConceptImportRow``): an absent
column keeps the concept's value, an empty one clears it; lists are
``|``-separated and mappings ``system:code:match``. Unknown notations create
DRAFT concepts (``concepts.create``), known live ones are updated; every row
is validated in memory by :func:`~bomesh.services.taxonomy.concepts.check_concept`
and the rows are written together, set-based, by
:func:`~bomesh.services.taxonomy.concepts.apply_writes`. ``broader`` and
``related`` may name concepts the same import creates. The import runs in a
savepoint: any problem (reported per field, ``rows[3].broader``) or
``validateOnly`` rolls everything back, so a real import applies every row
or none and ``validateOnly`` reports exactly what it would do.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import transaction_scope
from bomesh.db.models.taxonomy import MAPPING_MATCH_TYPES, Concept, ConceptScheme
from bomesh.errors import FieldViolation, InvalidArgument
from bomesh.services.kernel.context import RequestContext
from bomesh.services.taxonomy.concepts import (
    ConceptWrite,
    SchemeIndex,
    apply_writes,
    check_concept,
    concept_json,
    draft_concept,
)
from bomesh.services.taxonomy.names import concept_name, is_code, scheme_name
from bomesh.services.taxonomy.records import ImportResult
from bomesh.services.taxonomy.support import (
    TaxonomyDeps,
    audit,
    authorize,
    concept_views,
    load_scheme,
)

#: Import columns (``ConceptImportRow``).
COLUMNS = (
    "notation",
    "broader",
    "related",
    "prefVi",
    "prefEn",
    "altVi",
    "altEn",
    "hidden",
    "definition",
    "scopeNote",
    "examples",
    "color",
    "icon",
    "matchPatterns",
    "timeSensitive",
    "mappings",
)
MAX_ROWS = 5000
_SCALAR = {"definition": "definition", "scopeNote": "scopeNote", "color": "color", "icon": "icon"}
_LISTS = {"broader": "broader", "related": "related", "examples": "examples", "matchPatterns": "matchPatterns"}
#: (column, path, language) of label columns.
_LABEL_COLUMNS = (
    ("prefVi", "prefLabels", "vi"),
    ("prefEn", "prefLabels", "en"),
    ("altVi", "altLabels", "vi"),
    ("altEn", "altLabels", "en"),
    ("hidden", "hiddenLabels", "vi"),
)


def _split(value: str | None) -> list[str]:
    return [part.strip() for part in (value or "").split("|") if part.strip()]


def row_changes(
    row: Mapping[str, str],
    current: Any,
    prefix: str,
    problems: list[FieldViolation],
) -> dict[str, Any]:
    """The ``write_concept`` changes of one row (``current``: the concept's ConceptView or None)."""
    changes: dict[str, Any] = {}
    for column, path in _SCALAR.items():
        if column in row:
            changes[path] = row[column]
    for column, path in _LISTS.items():
        if column in row:
            changes[path] = _split(row[column])
    if "timeSensitive" in row:
        value = (row["timeSensitive"] or "").strip().lower()
        if value not in ("", "true", "false"):
            problems.append(FieldViolation(f"{prefix}timeSensitive", "true or false."))
        changes["timeSensitive"] = value == "true"
    if "mappings" in row:
        mappings = []
        for part in _split(row["mappings"]):
            system, _, rest = part.partition(":")
            code, _, match = rest.rpartition(":")
            if not system or not code or match.lower() not in MAPPING_MATCH_TYPES:
                problems.append(
                    FieldViolation(f"{prefix}mappings", f"'{part}' is not system:code:match (exact, close, broad, narrow).")
                )
                continue
            mappings.append((system, code, None, match.lower()))
        changes["mappings"] = mappings
    for path in ("prefLabels", "altLabels", "hiddenLabels"):
        columns = [(column, language) for column, target, language in _LABEL_COLUMNS if target == path and column in row]
        if not columns:
            continue
        languages = {language for _, language in columns}
        if current is None:
            kept: list[tuple[str, str]] = []
        elif path == "prefLabels":
            kept = [(language, text) for language, text in current.pref_labels.items() if language not in languages]
        else:
            source = current.alt_labels if path == "altLabels" else current.hidden_labels
            kept = [(language, text) for language, text in source if language not in languages]
        given = []
        for column, language in columns:
            values = [row[column].strip()] if path == "prefLabels" and (row[column] or "").strip() else []
            if path != "prefLabels":
                values = _split(row[column])
            given.extend((language, text) for text in values)
        changes[path] = kept + given
    return changes


class ImportService:
    def __init__(self, deps: TaxonomyDeps) -> None:
        self._deps = deps

    @classmethod
    def from_runtime(cls, runtime: Any) -> ImportService:
        return cls(TaxonomyDeps.from_runtime(runtime))

    async def import_concepts(
        self,
        ctx: RequestContext,
        tenant_id: UUID | None,
        scheme_code: str,
        rows: Sequence[Mapping[str, str]],
        *,
        validate_only: bool,
    ) -> ImportResult:
        await authorize(ctx, tenant_id, "concepts.update", write=not validate_only)
        if not rows:
            raise InvalidArgument.for_field("rows", "At least one row is required.")
        if len(rows) > MAX_ROWS:
            raise InvalidArgument.for_field("rows", f"At most {MAX_ROWS} rows.")
        async with transaction_scope(self._deps.sessions) as session:
            scheme = await load_scheme(session, tenant_id, scheme_code, for_update=not validate_only)
            index = await SchemeIndex.load(session, scheme)
            new = [
                str(row.get("notation") or "")
                for row in rows
                if str(row.get("notation") or "") not in index.by_notation
            ]
            if new:
                await authorize(ctx, tenant_id, "concepts.create", write=not validate_only)
            savepoint = await session.begin_nested()
            problems: list[FieldViolation] = []
            result = await self._apply(session, ctx, scheme, index, rows, problems)
            if problems or validate_only:
                await savepoint.rollback()
            else:
                await savepoint.commit()
            if problems:
                raise InvalidArgument(problems[0].description, field_violations=problems)
            if not validate_only:
                await audit(
                    session,
                    ctx,
                    tenant_id,
                    "ImportConcepts",
                    scheme_name(tenant_id, scheme_code),
                    details={
                        "rows": len(rows),
                        "created": list(result.created),
                        "updated": list(result.updated),
                    },
                )
            return result

    @staticmethod
    async def _apply(
        session: AsyncSession,
        ctx: RequestContext,
        scheme: ConceptScheme,
        index: SchemeIndex,
        rows: Sequence[Mapping[str, str]],
        problems: list[FieldViolation],
    ) -> ImportResult:
        planned: list[tuple[int, Concept, Any, bool]] = []
        seen: set[str] = set()
        for position, row in enumerate(rows):
            prefix = f"rows[{position}]."
            unknown = sorted(set(row) - set(COLUMNS))
            if unknown:
                problems.append(FieldViolation(f"{prefix}{unknown[0]}", f"Unknown column '{unknown[0]}'."))
                continue
            notation = str(row.get("notation") or "").strip()
            if not is_code(notation):
                problems.append(FieldViolation(f"{prefix}notation", "A notation matches ^[a-z][a-z0-9-]{0,62}$."))
                continue
            if notation in seen:
                problems.append(FieldViolation(f"{prefix}notation", f"'{notation}' is in two rows."))
                continue
            seen.add(notation)
            concept = index.by_notation.get(notation)
            if concept is not None and concept.deleted_at is not None:
                problems.append(FieldViolation(f"{prefix}notation", f"'{notation}' belonged to a deleted draft and stays reserved."))
                continue
            if concept is not None and concept.state == "deprecated":
                problems.append(FieldViolation(f"{prefix}notation", f"'{notation}' is deprecated."))
                continue
            created = concept is None
            if created:
                concept = draft_concept(session, ctx, index, notation)
            planned.append((position, concept, row, created))
        # One INSERT of the new concepts; the rows are validated in memory, then written set-based.
        await session.flush()
        before = await concept_views(session, scheme, [concept for _, concept, _, created in planned if not created])
        writes: list[ConceptWrite] = []
        for position, concept, row, _created in planned:
            prefix = f"rows[{position}]."
            current = before.get(concept.id)
            changes = row_changes(row, current, prefix, problems)
            write = check_concept(index, concept, changes, current=current, prefix=prefix, problems=problems)
            if write is not None:
                writes.append(write)
        if problems:
            return ImportResult((), (), 0)
        await apply_writes(session, index, writes)
        after = await concept_views(session, scheme, [concept for _, concept, _, _ in planned])
        # The index holds every concept of the scheme (deleted drafts and this import's too).
        names = {concept.id: concept.notation for concept in index.by_notation.values()}
        created_names, updated_names, unchanged = [], [], 0
        for _, concept, _, created in planned:
            name = concept_name(scheme.tenant_id, scheme.code, concept.notation)
            if created:
                created_names.append(name)
            elif concept_json(before[concept.id], names) != concept_json(after[concept.id], names):
                updated_names.append(name)
            else:
                unchanged += 1
        return ImportResult(tuple(created_names), tuple(updated_names), unchanged)


__all__ = ["COLUMNS", "ImportService", "row_changes"]
