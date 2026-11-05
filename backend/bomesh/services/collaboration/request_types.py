"""Request types (``…/spaces/{space}/requestTypes/{requestType}``): SERVICE request forms.

``fields`` describe the form, ``rules`` its eligibility conditions (compiled on
write, see :mod:`~bomesh.services.collaboration.eligibility`) and
``slaDuration`` the target resolution time that sets ``Request.dueTime``.
Soft delete keeps every existing request's reference; a DELETED type accepts
no new requests.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh import etag
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import RequestType, Space
from bomesh.errors import AlreadyExists, InvalidArgument, PermissionDenied
from bomesh.services.collaboration.eligibility import compile_condition, triggers
from bomesh.services.collaboration.records import RequestTypeRecord, space_name
from bomesh.services.collaboration.support import (
    Gate,
    missing,
    not_purged,
    now,
    replay,
)
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.idempotency import Idempotency
from bomesh.services.kernel.listing import ListQuery
from bomesh.services.kernel.retention import is_purged
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.knowledge_items.summary import get_item_summary, readable_item_ids

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

REQUEST_TYPE_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
FIELD_KEY = re.compile(r"^[a-z][a-zA-Z0-9]*$")
DURATION = re.compile(r"^([0-9]+(\.[0-9]+)?)s$")
FIELD_TYPES = ("STRING", "TEXT", "NUMBER", "BOOLEAN", "DATE", "SELECT", "ITEM")
SEVERITIES = ("BLOCK", "WARN")


@dataclass(frozen=True, slots=True)
class FieldSpec:
    key: str
    type: str
    display_name: str | None = None
    required: bool = False
    options: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RuleSpec:
    condition: str
    severity: str
    message: str | None = None
    policy_citation: str | None = None


@dataclass(frozen=True, slots=True)
class RuleResult:
    condition: str
    severity: str
    message: str | None
    policy_citation_item_id: str | None


@dataclass(frozen=True, slots=True)
class Eligibility:
    """PASS, WARN or BLOCK and the rules that triggered."""

    outcome: str
    results: tuple[RuleResult, ...]

    def stored(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome.lower(),
            "results": [
                {
                    "condition": result.condition,
                    "severity": result.severity.lower(),
                    "message": result.message,
                    "policy_citation_item_id": result.policy_citation_item_id,
                }
                for result in self.results
            ],
        }


class RequestTypeService:
    def __init__(self, sessions: SessionFactory, request_hash_secret: bytes) -> None:
        self._sessions = sessions
        self._secret = request_hash_secret
        self._gate = Gate(sessions)

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> RequestTypeService:
        return cls(runtime.sessions(), runtime.request_hash_secret())

    async def create(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        *,
        request_type_id: str | None,
        display_name: str,
        description: str | None,
        fields: Sequence[FieldSpec],
        rules: Sequence[RuleSpec],
        sla_duration: str | None,
        request_id: UUID | None,
    ) -> RequestTypeRecord:
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.create", write=True
        )
        type_code = (
            _type_id(request_type_id)
            if request_type_id is not None
            else f"type-{uuid4().hex[:12]}"
        )
        row = RequestType(
            space_id=space.id,
            code=type_code,
            display_name=_display_name(display_name),
            description=description or None,
            fields=_fields(fields),
            rules=_rules(workspace_id, rules),
            sla_duration=_duration(sla_duration),
            created_by_user_id=ctx.user_id,
        )
        async with transaction_scope(self._sessions) as session:
            idempotency = Idempotency(session, self._secret)
            key, replayed = await replay(
                idempotency,
                ctx,
                request_id,
                method="CreateRequestType",
                parent=space_name(workspace_id, code),
                request={
                    "requestTypeId": request_type_id,
                    "displayName": display_name,
                    "description": description,
                    "fields": row.fields,
                    "rules": row.rules,
                    "slaDuration": sla_duration,
                },
            )
            if replayed is not None:
                return await _record(
                    session, ctx, workspace_id, space, replayed.rsplit("/", 1)[-1]
                )
            if await _find(session, space.id, type_code) is not None:
                raise AlreadyExists(
                    f"The request type ID '{type_code}' is already taken."
                )
            await _require_citations(session, ctx, workspace_id, row.rules)
            session.add(row)
            await session.flush()
            record = await _for_reader(session, ctx, workspace_id, space, row)
            await _audit(session, ctx, workspace_id, "CreateRequestType", record.name)
            if key is not None:
                await idempotency.remember(key, record.name)
            return record

    async def get(
        self, ctx: RequestContext, workspace_id: UUID, code: str, type_code: str
    ) -> RequestTypeRecord:
        """A request type, soft-deleted ones included."""
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.get", write=False
        )
        async with transaction_scope(self._sessions) as session:
            return await _record(session, ctx, workspace_id, space, type_code)

    async def list(
        self, ctx: RequestContext, workspace_id: UUID, code: str, query: ListQuery
    ) -> list[RequestTypeRecord]:
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.list", write=False
        )
        statement = select(RequestType).where(RequestType.space_id == space.id)
        statement = statement.where(
            not_purged(RequestType.deleted_at)
            if query.show_deleted
            else RequestType.deleted_at.is_(None)
        )
        async with transaction_scope(self._sessions) as session:
            rows = await session.scalars(query.apply(statement))
            return [
                await _for_reader(session, ctx, workspace_id, space, row)
                for row in rows
            ]

    async def update(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        type_code: str,
        changes: Mapping[str, Any],
        *,
        expected_etag: str | None,
    ) -> RequestTypeRecord:
        """``changes`` keyed by mask path: displayName, description, fields, rules, slaDuration."""
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.update", write=True
        )
        async with transaction_scope(self._sessions) as session:
            record = await _record(
                session, ctx, workspace_id, space, type_code, for_update=True
            )
            etag.check(expected_etag, record.etag)
            row = record.request_type
            if "displayName" in changes:
                row.display_name = _display_name(changes["displayName"])
            if "description" in changes:
                row.description = changes["description"] or None
            if "fields" in changes:
                row.fields = _fields(changes["fields"] or ())
            if "rules" in changes:
                rules = _rules(workspace_id, changes["rules"] or ())
                await _require_citations(session, ctx, workspace_id, rules)
                row.rules = rules
            if "slaDuration" in changes:
                row.sla_duration = _duration(changes["slaDuration"])
            row.updated_at = now()
            await session.flush()
            await _audit(session, ctx, workspace_id, "UpdateRequestType", record.name)
            return await _for_reader(session, ctx, workspace_id, space, row)

    async def delete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        type_code: str,
        *,
        expected_etag: str | None,
    ) -> RequestTypeRecord:
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.delete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            record = await _record(
                session, ctx, workspace_id, space, type_code, for_update=True
            )
            etag.check(expected_etag, record.etag)
            if record.request_type.deleted_at is not None:
                raise missing(record.name)
            record.request_type.deleted_at = record.request_type.updated_at = now()
            await session.flush()
            await _audit(session, ctx, workspace_id, "DeleteRequestType", record.name)
            return record

    async def undelete(
        self,
        ctx: RequestContext,
        workspace_id: UUID,
        code: str,
        type_code: str,
        *,
        expected_etag: str | None,
    ) -> RequestTypeRecord:
        space = await self._gate.space(
            ctx, workspace_id, code, "requestTypes.undelete", write=True
        )
        async with transaction_scope(self._sessions) as session:
            record = await _record(
                session, ctx, workspace_id, space, type_code, for_update=True
            )
            etag.check(expected_etag, record.etag)
            if record.request_type.deleted_at is None:
                raise AlreadyExists(f"The request type '{type_code}' is not deleted.")
            record.request_type.deleted_at = None
            record.request_type.updated_at = now()
            await session.flush()
            await _audit(session, ctx, workspace_id, "UndeleteRequestType", record.name)
            return record


# -- Used by requests -----------------------------------------------------------


def validate_fields(
    request_type: RequestType, values: Mapping[str, Any]
) -> dict[str, Any]:
    """``values`` checked against the form: known keys, required ones present, typed values."""
    form = {entry["key"]: entry for entry in request_type.fields}
    unknown = sorted(set(values) - set(form))
    if unknown:
        raise InvalidArgument.for_field(
            "fields", f"Unknown fields for this request type: {', '.join(unknown)}."
        )
    for key, entry in form.items():
        value = values.get(key)
        if value is None or value == "":
            if entry.get("required"):
                raise InvalidArgument.for_field(
                    f"fields.{key}", f"'{key}' is required."
                )
            continue
        _check_value(key, entry, value)
    return dict(values)


def evaluate(
    request_type: RequestType,
    *,
    requester: Mapping[str, Any],
    fields: Mapping[str, Any],
) -> Eligibility:
    """Run the type's rules: BLOCK when any BLOCK rule triggers, WARN for a WARN rule, else PASS."""
    results: list[RuleResult] = []
    for index, rule in enumerate(request_type.rules):
        node = compile_condition(rule["condition"], field=f"rules[{index}].condition")
        if triggers(node, requester=requester, fields=fields):
            results.append(
                RuleResult(
                    condition=rule["condition"],
                    severity=rule["severity"].upper(),
                    message=rule.get("message"),
                    policy_citation_item_id=rule.get("policy_citation_item_id"),
                )
            )
    severities = {result.severity for result in results}
    outcome = "BLOCK" if "BLOCK" in severities else "WARN" if severities else "PASS"
    return Eligibility(outcome, tuple(results))


async def find_request_type(
    session: AsyncSession, space_id: UUID, code: str
) -> RequestType | None:
    return await _find(session, space_id, code)


# -- Internals ------------------------------------------------------------------


async def _find(
    session: AsyncSession, space_id: UUID, code: str, *, for_update: bool = False
) -> RequestType | None:
    statement = select(RequestType).where(
        RequestType.space_id == space_id, RequestType.code == code
    )
    return await session.scalar(
        statement.with_for_update() if for_update else statement
    )


async def _record(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    space: Space,
    type_code: str,
    *,
    for_update: bool = False,
) -> RequestTypeRecord:
    row = await _find(session, space.id, type_code, for_update=for_update)
    if row is None or is_purged(row.deleted_at):
        raise missing(
            f"{space_name(workspace_id, space.code)}/requestTypes/{type_code}"
        )
    return await _for_reader(session, ctx, workspace_id, space, row)


async def _for_reader(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    space: Space,
    row: RequestType,
) -> RequestTypeRecord:
    """The record with the ``policyCitation`` items this reader can read."""
    return RequestTypeRecord(
        workspace_id,
        space.code,
        row,
        await readable_citations(session, ctx, workspace_id, row.rules),
    )


async def readable_citations(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    rules: Sequence[Mapping[str, Any]],
) -> frozenset[str]:
    """The ``policy_citation_item_id`` values of ``rules`` the caller can read now."""
    cited = {
        UUID(rule["policy_citation_item_id"])
        for rule in rules
        if rule.get("policy_citation_item_id")
    }
    if not cited:
        return frozenset()
    readable = await readable_item_ids(
        session, ctx.authorizer, ctx.principal, workspace_id, cited
    )
    return frozenset(str(item_id) for item_id in readable)


async def _require_citations(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    rules: Sequence[Mapping[str, Any]],
) -> None:
    """Every ``policyCitation`` names a DOCUMENT the author can read (403 / 400 otherwise)."""
    for index, rule in enumerate(rules):
        cited = rule.get("policy_citation_item_id")
        if not cited:
            continue
        summary = await get_item_summary(
            session, ctx.authorizer, ctx.principal, workspace_id, UUID(cited)
        )
        name = item_name(workspace_id, UUID(cited))
        if summary is None:
            raise PermissionDenied(
                f"Permission 'items.get' denied on resource '{name}' (or it might not exist)",
                metadata={"permission": "items.get", "resource": name},
            )
        if summary.item_type != "DOCUMENT":
            raise InvalidArgument.for_field(
                f"rules[{index}].policyCitation", "policyCitation must name a DOCUMENT."
            )


def _type_id(value: str) -> str:
    if not REQUEST_TYPE_ID.match(value):
        raise InvalidArgument.for_field(
            "requestTypeId", "requestTypeId must match ^[a-z][a-z0-9-]{0,62}$."
        )
    return value


def _display_name(value: str | None) -> str:
    title = (value or "").strip()
    if not title:
        raise InvalidArgument.for_field("displayName", "displayName is required.")
    if len(title) > 255:
        raise InvalidArgument.for_field(
            "displayName", "displayName is longer than 255 characters."
        )
    return title


def _fields(fields: Sequence[FieldSpec]) -> list[dict[str, Any]]:
    stored: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, spec in enumerate(fields):
        path = f"fields[{index}]"
        if not FIELD_KEY.match(spec.key):
            raise InvalidArgument.for_field(
                f"{path}.key", "key must match ^[a-z][a-zA-Z0-9]*$."
            )
        if spec.key in seen:
            raise InvalidArgument.for_field(
                f"{path}.key", f"Duplicate field key '{spec.key}'."
            )
        seen.add(spec.key)
        if spec.type not in FIELD_TYPES:
            raise InvalidArgument.for_field(
                f"{path}.type", f"type must be one of {', '.join(FIELD_TYPES)}."
            )
        if spec.type == "SELECT" and not spec.options:
            raise InvalidArgument.for_field(
                f"{path}.options", "A SELECT field needs options."
            )
        if spec.type != "SELECT" and spec.options:
            raise InvalidArgument.for_field(
                f"{path}.options", "Only SELECT fields take options."
            )
        stored.append(
            {
                "key": spec.key,
                "display_name": spec.display_name,
                "type": spec.type.lower(),
                "required": spec.required,
                "options": list(spec.options),
            }
        )
    return stored


def _rules(workspace_id: UUID, rules: Sequence[RuleSpec]) -> list[dict[str, Any]]:
    stored: list[dict[str, Any]] = []
    for index, rule in enumerate(rules):
        compile_condition(rule.condition, field=f"rules[{index}].condition")
        if rule.severity not in SEVERITIES:
            raise InvalidArgument.for_field(
                f"rules[{index}].severity", "severity must be BLOCK or WARN."
            )
        citation = None
        if rule.policy_citation:
            citation = str(
                parse_item(
                    rule.policy_citation,
                    workspace_id,
                    field=f"rules[{index}].policyCitation",
                )
            )
        stored.append(
            {
                "condition": rule.condition,
                "severity": rule.severity.lower(),
                "message": rule.message,
                "policy_citation_item_id": citation,
            }
        )
    return stored


def _duration(value: str | None) -> timedelta | None:
    if not value:
        return None
    match = DURATION.match(value)
    if match is None:
        raise InvalidArgument.for_field(
            "slaDuration", "slaDuration must look like '86400s'."
        )
    return timedelta(seconds=float(match[1]))


def _check_value(key: str, entry: Mapping[str, Any], value: Any) -> None:
    kind = entry["type"]
    ok = {
        "string": isinstance(value, str),
        "text": isinstance(value, str),
        "number": isinstance(value, int | float) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "date": isinstance(value, str) and _is_date(value),
        "select": isinstance(value, str) and value in entry.get("options", ()),
        "item": isinstance(value, str) and value.count("/") == 3 and "/items/" in value,
    }[kind]
    if not ok:
        raise InvalidArgument.for_field(
            f"fields.{key}", f"'{key}' must be a valid {kind.upper()} value."
        )


def _is_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


async def _audit(
    session: AsyncSession,
    ctx: RequestContext,
    workspace_id: UUID,
    action: str,
    target: str,
) -> None:
    await Audit(session).record(
        ctx, workspace_id=workspace_id, category="spaces", action=action, target=target
    )


__all__ = [
    "Eligibility",
    "FieldSpec",
    "RequestTypeService",
    "RuleResult",
    "RuleSpec",
    "evaluate",
    "find_request_type",
    "validate_fields",
]
