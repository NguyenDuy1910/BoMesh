"""A parsed AIP list request (AIP-132/158/160) applied to a SQLAlchemy select.

The API boundary parses ``pageSize``, ``pageToken``, ``filter`` and
``orderBy`` (``api.v1.listing.list_query``) into a :class:`ListQuery`; the
service adds its own authorization predicates (e.g.
``ItemVisibility.clause()``) and applies the query. It never sees HTTP
parameters or page tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, Select, func, select


@dataclass(frozen=True, slots=True)
class ListQuery:
    """WHERE (from ``filter``), ORDER BY (from ``orderBy``) and the row window.

    ``limit`` is one more than the page size, so the boundary can tell whether
    another page exists.
    """

    where: ColumnElement[bool]
    order_by: tuple[ColumnElement[Any], ...]
    offset: int
    limit: int
    show_deleted: bool = False

    def apply[T: Select[Any]](self, statement: T) -> T:
        """``statement`` filtered, ordered and windowed."""
        return (
            statement.where(self.where)
            .order_by(*self.order_by)
            .offset(self.offset)
            .limit(self.limit)
        )

    def count(self, statement: Select[Any]) -> Select[Any]:
        """``SELECT count(*)`` of the filtered ``statement`` (``totalSize``)."""
        return select(func.count()).select_from(statement.where(self.where).subquery())


__all__ = ["ListQuery"]
