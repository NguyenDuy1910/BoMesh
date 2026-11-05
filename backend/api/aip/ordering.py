"""``orderBy`` (AIP-132): ``"field desc, other"`` against the fields a List method allows."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, UnaryExpression

from bomesh.errors import InvalidArgument


@dataclass(frozen=True, slots=True)
class OrderField:
    path: str
    descending: bool = False


def parse(order_by: str | None, *, field: str = "orderBy") -> list[OrderField]:
    """The ordered fields named by ``order_by``; syntax only, no field check."""
    if order_by is None or not order_by.strip():
        return []
    fields: list[OrderField] = []
    for clause in order_by.split(","):
        words = clause.split()
        if len(words) == 1:
            fields.append(OrderField(words[0]))
        elif len(words) == 2 and words[1] == "desc":
            fields.append(OrderField(words[0], descending=True))
        else:
            raise _error(
                f"invalid {field} clause {clause.strip()!r}; expected 'field' or 'field desc'",
                field,
            )
    return fields


class OrderSchema:
    """The sortable fields of one List method, keyed by lowerCamelCase path.

    ``tie_breaker`` columns (normally the primary key) are appended ascending so
    that pages are stable. ``default`` applies when the caller sends no orderBy.
    """

    def __init__(
        self,
        fields: Mapping[str, ColumnElement[Any]],
        *,
        tie_breaker: Sequence[ColumnElement[Any]],
        default: str = "",
        field: str = "orderBy",
    ) -> None:
        if not tie_breaker:
            raise ValueError("an order needs at least one tie-breaker column")
        self.fields = dict(fields)
        self.tie_breaker = tuple(tie_breaker)
        self.field = field
        try:
            self._check(parse(default, field=field))
        except InvalidArgument as exc:
            raise ValueError(
                f"invalid default order {default!r}: {exc.message}"
            ) from None
        self.default = default

    def compile(self, order_by: str | None) -> list[UnaryExpression[Any]]:
        """ORDER BY clauses for ``order_by`` (or the default), ending with the tie-breaker."""
        requested = parse(order_by, field=self.field) or parse(
            self.default, field=self.field
        )
        self._check(requested)
        clauses = [
            self.fields[item.path].desc()
            if item.descending
            else self.fields[item.path].asc()
            for item in requested
        ]
        return clauses + [column.asc() for column in self.tie_breaker]

    def _check(self, requested: list[OrderField]) -> None:
        seen: set[str] = set()
        for item in requested:
            if item.path not in self.fields:
                allowed = ", ".join(sorted(self.fields)) or "none"
                raise _error(
                    f"cannot order by {item.path!r}; allowed: {allowed}", self.field
                )
            if item.path in seen:
                raise _error(f"{item.path!r} appears more than once", self.field)
            seen.add(item.path)


def _error(description: str, field: str) -> InvalidArgument:
    return InvalidArgument.for_field(field, description)
