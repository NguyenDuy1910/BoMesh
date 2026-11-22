"""The object key convention (``database_architecture.md`` "Object storage")."""

from __future__ import annotations

from uuid import uuid4

import pytest

from bomesh.storage.keys import (
    MAP_BACKGROUND,
    PREVIEW,
    archive_member_content_id,
    asset_key,
    content_key,
    derived_key,
    derived_prefix,
    export_key,
    source_content_id,
    tenant_prefixes,
)


def test_every_tenant_key_is_under_one_of_its_prefixes_only() -> None:
    tenant, other = uuid4(), uuid4()
    content = uuid4()
    keys = [
        content_key(tenant, content),
        derived_key(tenant, content, PREVIEW, 1, "page-0001.webp"),
        asset_key(tenant, MAP_BACKGROUND, uuid4()),
        export_key(tenant, uuid4()),
    ]
    assert all(key.startswith(tenant_prefixes(tenant)) for key in keys)
    assert not any(key.startswith(tenant_prefixes(other)) for key in keys)
    assert derived_key(tenant, content, PREVIEW, 2).startswith(derived_prefix(tenant, content))
    assert not export_key(None, uuid4()).startswith(tenant_prefixes(tenant))


@pytest.mark.parametrize("part", ["../x", "Page.webp", "a/b", "", ".hidden"])
def test_unsafe_parts_are_rejected(part: str) -> None:
    with pytest.raises(ValueError):
        derived_key(uuid4(), uuid4(), PREVIEW, 1, part)


def test_unsafe_segments_and_versions_are_rejected() -> None:
    with pytest.raises(ValueError):
        asset_key(uuid4(), "../map", uuid4())
    with pytest.raises(ValueError):
        derived_key(uuid4(), uuid4(), PREVIEW, 0)
    with pytest.raises(ValueError):
        content_key("not-a-uuid", uuid4())  # type: ignore[arg-type]


def test_derived_identities_are_stable_and_unversioned_ones_fresh() -> None:
    assert source_content_id("c", "e", "v1") == source_content_id("c", "e", "v1")
    assert source_content_id("c", "e", "v1") != source_content_id("c", "e", "v2")
    assert source_content_id("c", "e", None) != source_content_id("c", "e", None)
    archive = uuid4()
    assert archive_member_content_id(archive, "a/b.txt") == archive_member_content_id(
        archive, "a/b.txt"
    )
    assert archive_member_content_id(archive, "a/b.txt") != archive_member_content_id(
        archive, "a/c.txt"
    )
