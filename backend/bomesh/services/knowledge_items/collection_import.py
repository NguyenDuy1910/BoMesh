"""ImportCollections planning: a folder tree's rows against the folders that exist.

:class:`FolderPlanner` decides every row in memory before anything is written,
so a row is never applied half-way and ``validateOnly`` reports exactly what the
import would do. :func:`load_folders` reads the existing folders the rows can
reach — live child collections the caller can read (the ListItems visibility
rule), level by level from the import's collection — with whether the caller
holds ``items.create`` on each.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.models import Item
from bomesh.iam.authorizer import Authorizer, Principal
from bomesh.iam.visibility import ItemVisibility
from bomesh.services.knowledge_items.records import CollectionImportRow

#: Most folders one row's ``path`` may name.
MAX_FOLDER_DEPTH = 8

_DEEP = f"A path can be at most {MAX_FOLDER_DEPTH} folders deep."
_LISTED = "This folder is already listed in an earlier row."
_AMBIGUOUS = "More than one folder here has this name."
_ABOVE = "A folder above it was skipped."
_NO_CREATE = "You can't add folders inside this folder."


@dataclass(eq=False, slots=True)
class Folder:
    """A folder of the tree: an existing collection, or one the plan creates.

    ``children`` holds the readable child folders by :func:`match_key`;
    ``may_create`` is whether the caller may add folders inside it.
    """

    item_id: UUID | None
    may_create: bool
    children: defaultdict[str, list[Folder]] = field(default_factory=lambda: defaultdict(list))
    #: The plan's entry when the import creates this folder.
    new: NewFolder | None = None


@dataclass(eq=False, slots=True)
class NewFolder:
    """A folder to create under ``parent``, in plan order (parents first).

    ``path`` is the trimmed display names from the import's collection down to
    it; ``row`` the 1-based row naming it (``None``: only a deeper row needs it).
    """

    parent: Folder
    folder: Folder
    name: str
    path: tuple[str, ...]
    row: int | None
    description: str | None


@dataclass(slots=True)
class FolderPlan:
    new: list[NewFolder] = field(default_factory=list)
    unchanged: int = 0
    #: ``(1-based row, reason)`` in row order.
    skipped: list[tuple[int, str]] = field(default_factory=list)


class _Skip(Exception):
    """A row that cannot apply; the message is its reason."""


def match_key(display_name: str) -> str:
    """How an import compares folder names: case and whitespace do not count."""
    return " ".join(display_name.split()).casefold()


def _wanted_keys(rows: Sequence[CollectionImportRow]) -> list[set[str]]:
    """The match keys the rows name at each depth: the only folders worth loading."""
    keys: list[set[str]] = [set() for _ in range(MAX_FOLDER_DEPTH)]
    for row in rows:
        for depth, segment in enumerate(row.path[:MAX_FOLDER_DEPTH]):
            keys[depth].add(match_key(segment))
    return keys


async def load_folders(
    session: AsyncSession,
    authorizer: Authorizer,
    principal: Principal,
    visibility: ItemVisibility,
    root: Item,
    rows: Sequence[CollectionImportRow],
) -> Folder:
    """The tree of readable live folders below ``root`` that ``rows`` can reach.

    One query per depth over the children of the previous depth's matches;
    ``items.create`` of every loaded folder is resolved in one batch.
    """
    tree = Folder(root.id, may_create=True)
    loaded: dict[UUID, Folder] = {root.id: tree}
    level = [root.id]
    for keys in _wanted_keys(rows):
        if not level or not keys:
            break
        children = await session.execute(
            select(Item.id, Item.parent_item_id, Item.item_name)
            .where(
                Item.tenant_id == root.tenant_id,
                Item.parent_item_id.in_(level),
                Item.item_kind == "collection",
                visibility.clause(),
            )
            .order_by(Item.id)
        )
        level = []
        for item_id, parent_id, name in children.tuples():
            key = match_key(name)
            if key not in keys:
                continue
            assert parent_id is not None
            folder = Folder(item_id, may_create=False)
            loaded[parent_id].children[key].append(folder)
            loaded[item_id] = folder
            level.append(item_id)
    below = [item_id for item_id in loaded if item_id != root.id]
    if below:
        held = await authorizer.collection_permissions_many(
            principal, ((item_id, False) for item_id in below)
        )
        for item_id in below:
            loaded[item_id].may_create = "items.create" in held[(item_id, False)]
    return tree


class FolderPlanner:
    """Plans rows in order against ``tree`` (:func:`load_folders`).

    A segment matches a child folder by :func:`match_key`; the first missing
    segment and every one after it are created. Rows are checked whole before
    anything of theirs is planned. A name an earlier row found ambiguous, or
    could not create, blocks the rows that need to go through it.
    """

    def __init__(self, tree: Folder, *, max_name: int) -> None:
        self._tree = tree
        self._bad_name = f"Every folder name must be 1 to {max_name} characters."
        self._max_name = max_name
        self._listed: set[tuple[str, ...]] = set()
        #: ``(parent, key)`` an earlier row skipped as ambiguous or not creatable.
        self._blocked: set[tuple[Folder, str]] = set()
        self.plan = FolderPlan()

    def plan_rows(self, rows: Sequence[CollectionImportRow]) -> FolderPlan:
        for position, row in enumerate(rows, start=1):
            try:
                self._row(position, row)
            except _Skip as skip:
                self.plan.skipped.append((position, str(skip)))
        return self.plan

    def _row(self, position: int, row: CollectionImportRow) -> None:
        names = tuple(segment.strip() for segment in row.path)
        if any(not name or len(name) > self._max_name for name in names):
            raise _Skip(self._bad_name)
        if len(names) > MAX_FOLDER_DEPTH:
            raise _Skip(_DEEP)
        keys = tuple(match_key(name) for name in names)
        if keys in self._listed:
            raise _Skip(_LISTED)
        self._listed.add(keys)
        description = (row.description or "").strip() or None
        folder = self._tree
        for depth, key in enumerate(keys):
            matches = folder.children[key]
            if len(matches) == 1:
                folder = matches[0]
                continue
            if depth < len(keys) - 1 and (folder, key) in self._blocked:
                raise _Skip(_ABOVE)
            if matches:
                self._blocked.add((folder, key))
                raise _Skip(_AMBIGUOUS)
            if not folder.may_create:
                self._blocked.add((folder, key))
                raise _Skip(_NO_CREATE)
            self._create(folder, names, depth, position, description)
            return
        if folder.new is not None and folder.new.row is None:
            # Created earlier only as an intermediate folder: this row names it.
            folder.new.row = position
            folder.new.description = description
        else:
            self.plan.unchanged += 1

    def _create(
        self,
        parent: Folder,
        names: tuple[str, ...],
        start: int,
        position: int,
        description: str | None,
    ) -> None:
        last = len(names) - 1
        for depth in range(start, len(names)):
            folder = Folder(None, may_create=True)
            folder.new = NewFolder(
                parent=parent,
                folder=folder,
                name=names[depth],
                path=names[: depth + 1],
                row=position if depth == last else None,
                description=description if depth == last else None,
            )
            parent.children[match_key(names[depth])].append(folder)
            self.plan.new.append(folder.new)
            parent = folder


__all__ = [
    "MAX_FOLDER_DEPTH",
    "Folder",
    "FolderPlan",
    "FolderPlanner",
    "NewFolder",
    "load_folders",
    "match_key",
]
