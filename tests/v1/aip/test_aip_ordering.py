"""``orderBy`` parsing and stable SQL ordering (AIP-132)."""

from __future__ import annotations

import pytest
from aip_docs import Doc
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.aip.ordering import OrderField, OrderSchema, parse
from bomesh.errors import InvalidArgument

ORDER = OrderSchema(
    {"size": Doc.size, "createTime": Doc.create_time, "displayName": Doc.display_name},
    tie_breaker=[Doc.id],
    default="createTime desc",
)


def _ids(session: Session, order_by: str | None) -> list[int]:
    return list(session.scalars(select(Doc.id).order_by(*ORDER.compile(order_by))))


def test_parse_reads_fields_and_desc() -> None:
    assert parse(" size desc ,displayName,  createTime  desc") == [
        OrderField("size", descending=True),
        OrderField("displayName"),
        OrderField("createTime", descending=True),
    ]


def test_ties_are_broken_by_the_tie_breaker(session: Session) -> None:
    # Docs 2 and 3 share size 20.
    assert _ids(session, "size desc") == [5, 2, 3, 1, 4]
    assert _ids(session, "size") == [4, 1, 2, 3, 5]


def test_default_order_applies_when_order_by_is_empty(session: Session) -> None:
    assert _ids(session, None) == [5, 4, 3, 2, 1]
    assert _ids(session, "  ") == [5, 4, 3, 2, 1]


def test_multiple_fields_sort_in_sequence(session: Session) -> None:
    assert _ids(session, "size, displayName desc") == [4, 1, 3, 2, 5]


@pytest.mark.parametrize(
    ("order_by", "fragment"),
    [
        ("state", "cannot order by 'state'"),
        ("size asc", "expected 'field' or 'field desc'"),
        ("size DESC", "expected 'field' or 'field desc'"),
        ("size,", "invalid orderBy clause ''"),
        ("size desc extra", "invalid orderBy clause"),
        ("size, size desc", "appears more than once"),
    ],
)
def test_bad_order_by_is_invalid_argument(order_by: str, fragment: str) -> None:
    with pytest.raises(InvalidArgument) as raised:
        ORDER.compile(order_by)

    [violation] = raised.value.field_violations
    assert violation.field == "orderBy"
    assert fragment in violation.description


def test_schema_rejects_an_invalid_default() -> None:
    with pytest.raises(ValueError):
        OrderSchema({"size": Doc.size}, tie_breaker=[Doc.id], default="state")
