"""``updateMask`` resolution and applying a masked update (AIP-134, AIP-161)."""

from __future__ import annotations

import pytest

from api.aip.fieldmask import FieldMask, MutableFields, apply
from api.aip.messages import ProtoMessage
from bomesh.errors import InvalidArgument


class Collection(ProtoMessage):
    description: str | None = None
    inherit_access: bool | None = None


class Item(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    etag: str | None = None
    collection: Collection | None = None


MUTABLE = MutableFields(
    ("displayName", "collection.description", "collection.inheritAccess")
)


def _item(payload: dict[str, object]) -> Item:
    return Item.model_validate(payload)


def test_explicit_mask_selects_the_named_fields() -> None:
    item = _item({"displayName": "New", "collection": {"description": "About"}})

    mask = MUTABLE.parse("collection.description", item)

    assert mask == FieldMask(("collection.description",))
    assert apply(mask, item) == {"collection.description": "About"}


def test_masked_field_absent_from_the_body_is_cleared() -> None:
    item = _item({"displayName": "New"})

    assert apply(MUTABLE.parse("displayName,collection.description", item), item) == {
        "displayName": "New",
        "collection.description": None,
    }


def test_parent_path_expands_to_its_mutable_children() -> None:
    item = _item({"collection": {"inheritAccess": False}})

    mask = MUTABLE.parse("collection", item)

    assert mask.paths == ("collection.description", "collection.inheritAccess")
    assert apply(mask, item) == {
        "collection.description": None,
        "collection.inheritAccess": False,
    }


def test_omitted_mask_updates_populated_mutable_fields_only() -> None:
    item = _item(
        {
            "name": "workspaces/w/items/i",
            "etag": "e1",
            "collection": {"inheritAccess": True},
        }
    )

    mask = MUTABLE.parse(None, item)

    assert mask.paths == ("collection.inheritAccess",)
    assert apply(mask, item) == {"collection.inheritAccess": True}


def test_explicit_null_in_the_body_counts_as_populated() -> None:
    item = _item({"displayName": None})

    assert apply(MUTABLE.parse("", item), item) == {"displayName": None}


def test_star_replaces_every_mutable_field() -> None:
    item = _item({"displayName": "Only"})

    mask = MUTABLE.parse("*", item)

    assert mask.full_replacement
    assert apply(mask, item) == {
        "displayName": "Only",
        "collection.description": None,
        "collection.inheritAccess": None,
    }


@pytest.mark.parametrize(
    "update_mask",
    [
        "name",
        "etag",
        "colour",
        "collection.owner",
        "displayName.first",
        "display_name",
        "displayName,",
        "*,name",
    ],
)
def test_immutable_unknown_or_malformed_paths_are_invalid(update_mask: str) -> None:
    with pytest.raises(InvalidArgument) as raised:
        MUTABLE.parse(update_mask, _item({}))

    assert raised.value.field_violations[0].field == "updateMask"
