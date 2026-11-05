"""Resource-name parsing and formatting (AIP-122, AIP-159)."""

from __future__ import annotations

from uuid import UUID

import pytest

from api.aip.names import ResourcePattern
from bomesh.errors import InvalidArgument

ITEM_ID = "0f8b3c1e-4d2a-4b7e-9a51-1c2d3e4f5a6b"

ITEM = ResourcePattern("workspaces/{workspace}/items/{item}", uuid=("item",))
MEMBER = ResourcePattern(
    "workspaces/{workspace}/members/{member}", aliases={"member": ("me",)}
)
TASK = ResourcePattern(
    "workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks/{task}",
    wildcard=("workspace", "ingestionRun"),
)


def test_parse_returns_ids_by_variable() -> None:
    assert ITEM.parse(f"workspaces/acme/items/{ITEM_ID}") == {
        "workspace": "acme",
        "item": ITEM_ID,
    }


def test_uuid_ids_are_canonicalized() -> None:
    assert ITEM.parse(f"workspaces/acme/items/{ITEM_ID.upper()}")["item"] == ITEM_ID


@pytest.mark.parametrize(
    "name",
    [
        "workspaces/acme/items",
        f"workspaces/acme/items/{ITEM_ID}/revisions",
        f"workspaces/acme/documents/{ITEM_ID}",
        f"workspaces//items/{ITEM_ID}",
        "workspaces/acme/items/not-a-uuid",
        "workspaces/acme/items/-",
        "",
    ],
)
def test_mismatch_is_invalid_argument_on_the_named_field(name: str) -> None:
    with pytest.raises(InvalidArgument) as raised:
        ITEM.parse(name, field="parentItem")

    assert [violation.field for violation in raised.value.field_violations] == [
        "parentItem"
    ]


def test_alias_is_accepted_only_where_declared() -> None:
    assert MEMBER.parse("workspaces/acme/members/me") == {
        "workspace": "acme",
        "member": "me",
    }
    with pytest.raises(InvalidArgument):
        ResourcePattern("workspaces/{workspace}/members/{member}").parse(
            "workspaces/me/members/-"
        )


def test_wildcard_reads_across_parents_only_where_declared() -> None:
    assert TASK.parse("workspaces/-/ingestionRuns/-/tasks/t1") == {
        "workspace": "-",
        "ingestionRun": "-",
        "task": "t1",
    }
    with pytest.raises(InvalidArgument):
        TASK.parse("workspaces/acme/ingestionRuns/r1/tasks/-")


def test_format_round_trips_and_requires_every_id() -> None:
    name = ITEM.format(workspace="acme", item=UUID(ITEM_ID))

    assert name == f"workspaces/acme/items/{ITEM_ID}"
    assert ITEM.parse(name) == {"workspace": "acme", "item": ITEM_ID}
    with pytest.raises(ValueError):
        ITEM.format(workspace="acme")
    with pytest.raises(ValueError):
        ITEM.format(workspace="acme/other", item=ITEM_ID)


def test_pattern_options_must_name_pattern_variables() -> None:
    with pytest.raises(ValueError):
        ResourcePattern("workspaces/{workspace}", uuid=("item",))
