"""AIP-160 filters: parsed, compiled and run against SQLite; errors land on ``filter``."""

from __future__ import annotations

import pytest
from aip_docs import Doc, DocTag
from sqlalchemy import exists, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from api.aip import filtering as f
from api.aip.filtering import And, FilterSchema, Not, Operator, Or, Restriction, Value
from api.aip.names import ResourcePattern
from bomesh.errors import InvalidArgument

USER = ResourcePattern("users/{user}")


def _owner_id(name: str) -> str | None:
    return None if name == "" else USER.parse(name)["user"]


def _has_tag(tag: str):
    return exists().where(DocTag.doc_id == Doc.id, DocTag.tag == tag)


SCHEMA = FilterSchema(
    {
        "displayName": f.string(Doc.display_name),
        "state": f.enum(Doc.state, ("ACTIVE", "DRAFT", "ARCHIVED")),
        "size": f.integer(Doc.size),
        "pinned": f.boolean(Doc.pinned),
        "createTime": f.timestamp(Doc.create_time),
        "owner": f.resource_name(Doc.owner_id, _owner_id),
        "tags": f.repeated(f.string(DocTag.tag), has=_has_tag),
    }
)


def _ids(session: Session, filter_text: str) -> list[int]:
    return list(
        session.scalars(
            select(Doc.id).where(SCHEMA.compile(filter_text)).order_by(Doc.id)
        )
    )


@pytest.mark.parametrize(
    ("filter_text", "expected"),
    [
        ("", [1, 2, 3, 4, 5]),
        ("state = ACTIVE", [1, 2]),
        ('state = "DRAFT"', [3, 5]),
        ("state != ACTIVE", [3, 4, 5]),
        ("size >= 20", [2, 3, 5]),
        ("size < 0", [4]),
        ("size = -3", [4]),
        ("size>5 AND size<=20", [2, 3]),
        ("pinned = true", [1, 4]),
        ("NOT pinned = true", [2, 3, 5]),
        ("-pinned = true", [2, 3, 5]),
        ('displayName = "Say \\"hi\\""', [3]),
        ('displayName > "D"', [3, 4, 5]),
        ('createTime >= "2026-11-04T00:00:00Z"', [4, 5]),
        # 14:00 at +02:00 is noon UTC on the 3rd.
        ('createTime <= "2026-11-03T14:00:00+02:00"', [1, 2, 3]),
        ('owner = "users/u1"', [1, 4]),
        # NULL owners differ from every name, as unset proto fields do.
        ('owner != "users/u1"', [2, 3, 5]),
        ("owner = null", [3]),
        ('owner = ""', [3]),
        ("owner != null", [1, 2, 4, 5]),
        ('tags:"hr"', [1, 2]),
        ("tags:faq", [1]),
        ("-tags:hr", [3, 4, 5]),
        ("state = ACTIVE OR state = ARCHIVED", [1, 2, 4]),
        # OR binds tighter than AND (AIP-160).
        ("pinned = true AND state = ACTIVE OR state = DRAFT", [1]),
        ("(pinned = true AND state = ACTIVE) OR state = DRAFT", [1, 3, 5]),
        # Juxtaposed terms are ANDed.
        ("state = DRAFT size > 20", [5]),
        ("NOT (state = ACTIVE OR size > 20)", [3, 4]),
        ("((state = ACTIVE))", [1, 2]),
    ],
)
def test_compiled_filter_selects_matching_rows(
    session: Session, filter_text: str, expected: list[int]
) -> None:
    assert _ids(session, filter_text) == expected


def test_parse_builds_the_ast() -> None:
    node = f.parse('a = 1 AND -b:x OR c != "y"')

    assert node == And(
        (
            Restriction("a", Operator.EQ, Value("1", quoted=False)),
            Or(
                (
                    Not(Restriction("b", Operator.HAS, Value("x", quoted=False))),
                    Restriction("c", Operator.NE, Value("y", quoted=True)),
                )
            ),
        )
    )


def test_restrictions_expose_referenced_resource_names() -> None:
    node = f.parse('owner = "users/u1" OR (state = ACTIVE AND NOT owner = "users/u9")')

    owners = [r.value.text for r in f.restrictions(node) if r.field == "owner"]

    assert owners == ["users/u1", "users/u9"]


def test_default_has_compiles_to_postgres_any() -> None:
    from sqlalchemy import ARRAY, Column, MetaData, String, Table

    table = Table("t", MetaData(), Column("labels", ARRAY(String)))
    schema = FilterSchema({"labels": f.repeated(f.string(table.c.labels))})

    sql = str(
        schema.compile('labels:"x"').compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )

    assert sql == "'x' = ANY (t.labels)"


@pytest.mark.parametrize(
    ("filter_text", "fragment"),
    [
        ("colour = red", "unknown filter field 'colour'"),
        ("state > ACTIVE", "only supports '=' and '!='"),
        ("pinned < true", "only supports '=' and '!='"),
        ("state = DELETED", "expected one of ACTIVE, ARCHIVED, DRAFT"),
        ("size = big", "expected an integer"),
        ("size = 99999999999999999999", "out of the int64 range"),
        ('pinned = "true"', "expected true or false"),
        ('createTime > "yesterday"', "RFC 3339"),
        ('createTime > "2026-11-04T00:00:00"', "UTC offset"),
        ('owner = "workspaces/w1"', "invalid value for owner"),
        ("tags = hr", "filter it with 'tags:value'"),
        ("size:5", "':' applies only to repeated fields"),
        ("size > null", "compared with null"),
        ("state", "free-text filters are not supported"),
        ("ACTIVE", "free-text filters are not supported"),
        ("state =", "ends unexpectedly"),
        ("= ACTIVE", "unexpected '='"),
        ("(state = ACTIVE", "ends unexpectedly"),
        ("state = ACTIVE)", "unexpected ')'"),
        ("state = ACTIVE OR", "ends unexpectedly"),
        ("state = ACTIVE AND AND size = 1", "unexpected 'AND'"),
        ("state == ACTIVE", "unexpected '='"),
        ("state = ACTIVE & size = 1", "unexpected character '&'"),
        ('displayName = "open', "unexpected character"),
        ("size = - 3", "unexpected '3'"),
        ("(" * 40 + "size = 1" + ")" * 40, "nests deeper"),
    ],
)
def test_bad_filters_are_invalid_argument_on_filter(
    filter_text: str, fragment: str
) -> None:
    with pytest.raises(InvalidArgument) as raised:
        SCHEMA.compile(filter_text)

    [violation] = raised.value.field_violations
    assert violation.field == "filter"
    assert fragment in violation.description


def test_violation_field_follows_the_request_field() -> None:
    schema = FilterSchema(
        {"state": f.enum(Doc.state, ("ACTIVE",))}, field="query.filter"
    )

    with pytest.raises(InvalidArgument) as raised:
        schema.compile("state = GONE")

    assert raised.value.field_violations[0].field == "query.filter"


def test_overlong_filter_is_rejected() -> None:
    with pytest.raises(InvalidArgument):
        f.parse("size = 1 AND " * 500 + "size = 1")
