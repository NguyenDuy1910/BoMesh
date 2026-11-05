"""``users/{user}`` references: the one parser other slices use (``parse_user_name``)."""

from __future__ import annotations

from uuid import uuid4

import pytest

from bomesh.services.identity.records import parse_user_name, user_name
from bomesh.errors import InvalidArgument


def test_a_user_name_round_trips() -> None:
    user_id = uuid4()

    assert parse_user_name(user_name(user_id), field="user") == user_id


@pytest.mark.parametrize(
    "name",
    ["users/me", "users/not-a-uuid", "users/", "users", f"members/{uuid4()}", f"users/{uuid4()}/x"],
)
def test_anything_else_is_invalid_on_the_named_field(name: str) -> None:
    with pytest.raises(InvalidArgument) as raised:
        parse_user_name(name, field="actor")

    assert [v.field for v in raised.value.field_violations] == ["actor"]
