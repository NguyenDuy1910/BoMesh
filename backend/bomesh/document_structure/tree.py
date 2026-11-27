"""Which node a reader sees: the block a Docling node belongs to.

Docling splits a formatted sentence into an ``inline`` group of words and puts
a list item's formatted text in an ``inline`` child. A reader sees one
paragraph or one list item, so references are always made to that **block**.
The chunker (on a ``DoclingDocument``) and the view (on its JSON) apply the
same rule through :class:`NodeTree`.
"""

from __future__ import annotations

from typing import Protocol

from docling_core.types.doc import DoclingDocument, RefItem

from .identity import node_ref, self_ref

#: Labels of groups that are one block (their children are its runs).
INLINE = "inline"
#: Labels of list groups and items.
LIST_GROUPS = frozenset({"list", "ordered_list"})
LIST_ITEM = "list_item"
CAPTION = "caption"
#: Content of these labels is page furniture, never part of the reading flow.
FURNITURE_LABELS = frozenset({"page_header", "page_footer"})


class NodeTree(Protocol):
    """Read-only access to a Structured Document's node graph, by :data:`NodeRef`."""

    def label(self, ref: str) -> str | None: ...

    def parent(self, ref: str) -> str | None:
        """The parent node ref, ``None`` at the body or for an unknown ref."""
        ...

    def caption_owner(self, ref: str) -> str | None:
        """The table or picture a caption belongs to."""
        ...


def block_ref(tree: NodeTree, ref: str) -> str:
    """The block ``ref`` is shown in: itself, its inline group, its list item, its table."""

    if tree.label(ref) == CAPTION and (owner := tree.caption_owner(ref)) is not None:
        return owner
    current = ref
    while (parent := tree.parent(current)) is not None and tree.label(parent) == INLINE:
        current = parent
    if tree.label(current) == INLINE:
        parent = tree.parent(current)
        if parent is not None and tree.label(parent) == LIST_ITEM:
            return parent
    return current


class DoclingTree:
    """:class:`NodeTree` over a validated ``DoclingDocument``."""

    def __init__(self, document: DoclingDocument) -> None:
        self._document = document
        self._captions: dict[str, str] = {}
        for owner in (*document.tables, *document.pictures):
            for caption in owner.captions:
                self._captions[node_ref(caption.cref)] = node_ref(owner.self_ref)

    def label(self, ref: str) -> str | None:
        item = self._item(ref)
        label = getattr(item, "label", None)
        return getattr(label, "value", label) if label is not None else None

    def parent(self, ref: str) -> str | None:
        item = self._item(ref)
        parent = getattr(item, "parent", None)
        if parent is None or parent.cref == "#/body" or not parent.cref.startswith("#/"):
            return None
        try:
            return node_ref(parent.cref)
        except ValueError:
            return None

    def caption_owner(self, ref: str) -> str | None:
        return self._captions.get(ref)

    def _item(self, ref: str) -> object | None:
        try:
            return RefItem(cref=self_ref(ref)).resolve(self._document)
        except (KeyError, IndexError, ValueError):
            return None


__all__ = [
    "CAPTION",
    "FURNITURE_LABELS",
    "INLINE",
    "LIST_GROUPS",
    "LIST_ITEM",
    "DoclingTree",
    "NodeTree",
    "block_ref",
]
