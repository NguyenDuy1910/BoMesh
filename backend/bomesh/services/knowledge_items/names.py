"""Resource names of the Item family (AIP-122): the one builder and parser per name.

Other resources are named by their owners: members (``workspaces.records``),
topics and contributions (``knowledge_curation.records``), sources
(``ingestion.names``), spaces (``collaboration``), workspaces (``kernel``).
"""

from __future__ import annotations

from uuid import UUID

from bomesh.errors import InvalidArgument


def item_name(workspace_id: UUID, item_id: UUID) -> str:
    return f"workspaces/{workspace_id}/items/{item_id}"


def revision_name(workspace_id: UUID, item_id: UUID, number: int) -> str:
    return f"{item_name(workspace_id, item_id)}/revisions/{number}"


def passage_name(workspace_id: UUID, item_id: UUID, chunk_id: str) -> str:
    return f"{item_name(workspace_id, item_id)}/passages/{chunk_id}"


def link_name(workspace_id: UUID, collection_id: UUID, target_id: UUID) -> str:
    return f"{item_name(workspace_id, collection_id)}/links/{target_id}"


def parse_item(name: str, workspace_id: UUID, *, field: str) -> UUID:
    """The item ID of ``workspaces/{workspace}/items/{item}`` in this workspace."""
    parts = name.split("/")
    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "items":
        try:
            parent, child = UUID(parts[1]), UUID(parts[3])
        except ValueError:
            pass
        else:
            if parent == workspace_id:
                return child
    raise InvalidArgument.for_field(field, f"'{name}' is not an item name of this workspace.")


def parse_revision(value: str, workspace_id: UUID, item_id: UUID, *, field: str) -> int:
    """A revision number, given as a number or as the revision's name."""
    prefix = f"{item_name(workspace_id, item_id)}/revisions/"
    number = value[len(prefix) :] if value.startswith(prefix) else value
    if not number.isdigit() or int(number) < 1:
        raise InvalidArgument.for_field(field, f"'{value}' is not a revision of this item.")
    return int(number)


__all__ = [
    "item_name",
    "link_name",
    "parse_item",
    "parse_revision",
    "passage_name",
    "revision_name",
]
