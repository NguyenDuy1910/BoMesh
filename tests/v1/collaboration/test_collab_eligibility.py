"""The CEL-subset evaluator of request type rules."""

from __future__ import annotations

import pytest

from bomesh.services.collaboration.eligibility import compile_condition, triggers
from bomesh.errors import InvalidArgument

REQUESTER = {
    "displayName": "Ann",
    "email": "ann@corp.example",
    "emailDomain": "corp.example",
}


def run(condition: str, **fields: object) -> bool:
    return triggers(
        compile_condition(condition, field="c"), requester=REQUESTER, fields=fields
    )


@pytest.mark.parametrize(
    ("condition", "fields", "expected"),
    [
        ("fields.days > 10", {"days": 12}, True),
        ("fields.days > 10", {"days": 3}, False),
        (
            "fields.days >= 2.5 && fields.kind == 'paid'",
            {"days": 3, "kind": "paid"},
            True,
        ),
        ("fields.kind in ['a', 'b']", {"kind": "b"}, True),
        ("!(fields.urgent)", {"urgent": False}, True),
        ("size(fields.reason) < 5", {"reason": "abc"}, True),
        ("fields.reason.size() == 3", {"reason": "abc"}, True),
        ("requester.emailDomain != 'corp.example'", {}, False),
        ("requester.email.endsWith('@corp.example')", {}, True),
        ("has(fields.days)", {}, False),
        ("fields.days * 2 - 1 == 5", {"days": 3}, True),
        ("fields['days'] % 2 == 1", {"days": 3}, True),
        # Errors never trigger, but && / || absorb them when the other side decides.
        ("fields.missing > 1", {}, False),
        ("fields.missing > 1 || fields.days > 1", {"days": 2}, True),
        ("fields.missing > 1 && false", {}, False),
        ("fields.days > 'x'", {"days": 2}, False),
        ("fields.days / 0 > 1", {"days": 2}, False),
    ],
)
def test_evaluation(condition: str, fields: dict[str, object], expected: bool) -> None:
    assert run(condition, **fields) is expected


@pytest.mark.parametrize(
    "condition",
    [
        "",
        "fields.days >",
        "os.system('x')",
        "fields.days > 1; 2",
        "__import__('os')",
        "eval(fields.x)",
        "has(1)",
        "fields.x.lower()",
        "(" * 40 + "true" + ")" * 40,
    ],
)
def test_invalid_conditions_are_rejected(condition: str) -> None:
    with pytest.raises(InvalidArgument):
        compile_condition(condition, field="rules[0].condition")
