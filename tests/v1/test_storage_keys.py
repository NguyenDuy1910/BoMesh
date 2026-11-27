"""The object key convention (``database_architecture.md`` "Object storage")."""

from __future__ import annotations

from uuid import uuid4

import pytest

from bomesh.storage.keys import (
    MAP_BACKGROUND,
    STRUCTURE,
    archive_member_content_id,
    asset_key,
    content_key,
    derived_key,
    export_key,
    file_prefix,
    source_content_id,
    taxonomy_cards_key,
    workspace_prefix,
)


def test_a_key_names_its_workspace_part_and_file() -> None:
    content, image, operation = uuid4(), uuid4(), uuid4()

    assert content_key("hcmute", content) == f"workspaces/hcmute/files/{content}/original"
    assert asset_key("hcmute", MAP_BACKGROUND, image) == (
        f"workspaces/hcmute/branding/map-background/{image}"
    )
    assert export_key("hcmute", operation) == f"workspaces/hcmute/exports/{operation}.csv"
    assert export_key(None, operation) == f"platform/exports/{operation}.csv"
    assert taxonomy_cards_key("hcmute", "domain", 3, "openai/Text-Embedding-3-Large") == (
        "workspaces/hcmute/taxonomies/domain/3/cards-openai-text-embedding-3-large.json"
    )


def test_a_workspace_owns_only_its_prefix_and_a_file_its_folder() -> None:
    content = uuid4()
    keys = [
        content_key("hcmute", content),
        derived_key("hcmute", content, STRUCTURE, 1, "0123456789abcdef.json.gz"),
        asset_key("hcmute", MAP_BACKGROUND, uuid4()),
        export_key("hcmute", uuid4()),
        taxonomy_cards_key("hcmute", "domain", 1, "text-embedding-3-small"),
    ]
    assert all(key.startswith(workspace_prefix("hcmute")) for key in keys)
    # A code that extends another's is a different folder.
    assert not any(key.startswith(workspace_prefix("hcm")) for key in keys)
    assert not export_key(None, uuid4()).startswith(workspace_prefix("hcmute"))
    # Purging a file deletes its original and everything built from it.
    folder = file_prefix("hcmute", content)
    assert keys[0].startswith(folder) and keys[1].startswith(folder)


@pytest.mark.parametrize("part", ["../x", "Page.webp", "a/b", "", ".hidden"])
def test_unsafe_parts_are_rejected(part: str) -> None:
    with pytest.raises(ValueError):
        derived_key("hcmute", uuid4(), STRUCTURE, 1, part)


@pytest.mark.parametrize("workspace", ["", "HCMUTE", "a", "-x-", "../x", "a/b", "platform/x"])
def test_only_workspace_codes_scope_a_key(workspace: str) -> None:
    with pytest.raises(ValueError):
        content_key(workspace, uuid4())


def test_unsafe_segments_and_versions_are_rejected() -> None:
    with pytest.raises(ValueError):
        asset_key("hcmute", "../map", uuid4())
    with pytest.raises(ValueError):
        derived_key("hcmute", uuid4(), STRUCTURE, 0)
    with pytest.raises(ValueError):
        content_key("hcmute", "not-a-uuid")  # type: ignore[arg-type]


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
