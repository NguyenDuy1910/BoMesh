"""Item projection is set-based (``Projector.project_many``).

ListItems costs a bounded number of SQL statements whatever the page size, and
an item projects in a list exactly as GetItem projects it for the same caller.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from sqlalchemy import event, update

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Item, ItemConcept, ItemShortcut, ItemRevision, ItemUpload, User
from bomesh.storage.keys import new_content_id
from harness import ApiClient, Sessions, World
from knowledge_support import item_name, ws_url
from taxonomy_support import C, publish_scheme

pytestmark = pytest.mark.asyncio

VIEWER = "roles/collectionViewer"
EDITOR = "roles/collectionEditor"
OWNER = "roles/collectionOwner"
#: Statements one ListItems call may cost, request authentication included.
MAX_STATEMENTS = 25


@contextmanager
def counting(sessions: Sessions) -> Iterator[dict[str, int]]:
    """Count SQL statements and pool checkouts while the block runs."""
    engine = sessions.kw["bind"].sync_engine
    counts = {"statements": 0, "checkouts": 0}

    def on_execute(*_: Any) -> None:
        counts["statements"] += 1

    def on_checkout(*_: Any) -> None:
        counts["checkouts"] += 1

    event.listen(engine, "before_cursor_execute", on_execute)
    event.listen(engine.pool, "checkout", on_checkout)
    try:
        yield counts
    finally:
        event.remove(engine, "before_cursor_execute", on_execute)
        event.remove(engine.pool, "checkout", on_checkout)


#: The status each built document gets once ``_decorate`` gave it its content.
_WANTED: dict[int, str] = {}


def _document(parent: Item, name: str, *, published: bool = True, status: str = "ready") -> Item:
    """A PDF document row without content; :func:`_decorate` makes its content ``status``
    (``available`` with revisions, else ``pending`` with an upload)."""
    document = Item(
        tenant_id=parent.tenant_id,
        item_kind="document",
        item_type="pdf",
        parent_item_id=parent.id,
        item_name=name,
        purpose="knowledge",
        is_published=published,
    )
    _WANTED[id(document)] = status
    return document


async def _decorate(
    sessions: Sessions,
    documents: list[Item],
    *,
    uploader: User,
    links: list[tuple[Item, Item]] = (),  # type: ignore[assignment]
) -> None:
    """Give documents concepts, revisions and pending uploads, and add shortcuts."""
    workspace_id = documents[0].tenant_id
    subject = await publish_scheme(
        sessions, workspace_id, uploader.id, "subject", [C("finance", "Finance"), C("legal", "Legal")]
    )
    async with transaction_scope(sessions) as session:
        for position, document in enumerate(documents):
            for notation in ("finance", "legal")[: position % 3]:
                session.add(
                    ItemConcept(
                        item_id=document.id,
                        concept_id=subject[notation],
                        scheme_id=subject.scheme_id,
                        source="human",
                        state="accepted",
                        created_by_user_id=uploader.id,
                    )
                )
            if _WANTED.pop(id(document), "ready") == "pending":
                session.add(
                    ItemUpload(
                        item_id=document.id,
                        tenant_id=workspace_id,
                        owner_user_id=uploader.id,
                        content_id=new_content_id(),
                        mime_type="application/pdf",
                        size_bytes=10,
                        file_name=f"{document.item_name}.pdf",
                    )
                )
                continue
            revisions = [
                ItemRevision(
                    item_id=document.id,
                    revision_number=number,
                    content_id=new_content_id(),
                    mime_type="application/pdf",
                    size_bytes=10,
                    file_name=f"{document.item_name}.pdf",
                )
                for number in range(1, position % 3 + 2)
            ]
            session.add_all(revisions)
            await session.flush()
            await session.execute(
                update(Item)
                .where(Item.id == document.id)
                .values(current_revision_id=revisions[-1].id)
            )
        for collection, target in links:
            session.add(
                ItemShortcut(
                    tenant_id=workspace_id,
                    collection_item_id=collection.id,
                    target_item_id=target.id,
                )
            )


async def _list(api: ApiClient, workspace: Any, view: str, size: int = 200) -> list[dict[str, Any]]:
    response = await api.get(
        f"{ws_url(workspace)}/items",
        params={"pageSize": size, "view": view, "showLocked": "true", "showDeleted": "true"},
    )
    assert response.status_code == 200, response.text
    return response.json()["items"]


async def test_list_items_statements_do_not_grow_with_the_page_size(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    viewer = await world.add_member(workspace)
    editor = await world.add_member(workspace)
    grants = {viewer: VIEWER, editor: EDITOR}
    documents: list[Item] = []
    subs: list[Item] = []
    for r in range(2):
        root = await world.make_collection(workspace, item_name=f"Root {r}", grants=grants)
        for c in range(3):
            sub = await world.make_collection(
                workspace,
                root,
                item_name=f"Sub {r}.{c}",
                inherit_access=c != 2,
                grants=grants if c == 2 else None,
            )
            subs.append(sub)
            async with transaction_scope(sessions) as session:
                batch = [
                    _document(
                        sub,
                        f"Doc {r}.{c}.{d}",
                        published=d % 4 != 0,
                        status="pending" if d % 10 == 5 else "ready",
                    )
                    for d in range(60)
                ]
                session.add_all(batch)
            documents.extend(batch)
    await _decorate(
        sessions,
        documents,
        uploader=editor,
        links=[(subs[0], documents[-1]), (subs[3], documents[0]), (subs[3], documents[1])],
    )

    for user in (admin, viewer, editor):
        api = await client.as_(user)
        for view in ("BASIC", "FULL"):
            measured: dict[int, dict[str, int]] = {}
            for size in (20, 200):
                with counting(sessions) as counts:
                    items = await _list(api, workspace, view, size)
                assert len(items) == size
                measured[size] = dict(counts)
            small, large = measured[20], measured[200]
            assert large["statements"] < MAX_STATEMENTS, (view, measured)
            assert large["statements"] <= small["statements"] + 2, (view, measured)
            assert large["checkouts"] <= small["checkouts"] + 1, (view, measured)


async def test_listed_items_project_exactly_as_get_item(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    owner, editor, viewer, grouped, member = [await world.add_member(workspace) for _ in range(5)]
    group = await world.make_group(workspace, [grouped])

    restricted = await world.make_collection(
        workspace,
        item_name="Restricted",
        grants={owner: OWNER, editor: EDITOR, viewer: VIEWER},
    )
    inherited = await world.make_collection(workspace, restricted, item_name="Inherited")
    boundary = await world.make_collection(
        workspace, restricted, item_name="Boundary", inherit_access=False, grants={group: VIEWER}
    )
    deleted = await world.make_collection(workspace, restricted, item_name="Deleted")
    deleted_nested = await world.make_collection(workspace, deleted, item_name="Deleted nested")
    everyone = await world.make_collection(
        workspace, item_name="Everyone", grants={"workspaceMembers": VIEWER}
    )
    discoverable = await world.make_collection(workspace, item_name="Discoverable")
    opened = await world.make_collection(
        workspace, discoverable, item_name="Opened", inherit_access=False, grants={viewer: VIEWER}
    )
    personal = await world.make_collection(workspace, item_name="Mine", personal_for=viewer)
    async with transaction_scope(sessions) as session:
        await session.execute(
            update(Item)
            .where(Item.id == discoverable.id)
            .values(discoverable=True, description="Ask to join")
        )
        published = _document(inherited, "Published")
        session.add(published)
        await session.flush()
        documents = [
            published,
            _document(published, "Published child"),
            _document(inherited, "Draft", published=False),
            _document(inherited, "Pending upload", status="pending"),
            behind := _document(boundary, "Behind boundary"),
            _document(boundary, "Boundary draft", published=False),
            _document(deleted, "Deleted document"),
            _document(deleted_nested, "Deleted draft", published=False),
            _document(everyone, "Shared"),
            _document(opened, "Opened document"),
            _document(personal, "Personal document"),
        ]
        session.add_all(documents[1:])
    await _decorate(
        sessions,
        documents,
        uploader=editor,
        links=[(everyone, published), (everyone, behind), (opened, published)],
    )
    await world.delete(deleted)

    for user in (admin, owner, editor, viewer, grouped, member):
        api = await client.as_(user)
        for view in ("FULL", "BASIC"):
            listed = await _list(api, workspace, view)
            assert listed
            for item in listed:
                response = await api.get(
                    f"/api/v1/{item['name']}", params={"view": view}
                )
                assert response.status_code == 200, (item["displayName"], response.text)
                assert item == response.json(), item["displayName"]

    def by_title(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        return {item["displayName"]: item for item in items}

    def ancestors(item: dict[str, Any]) -> list[str]:
        return [ancestor["displayName"] for ancestor in item["ancestors"]]

    seen = {
        user.id: by_title(await _list(await client.as_(user), workspace, "FULL"))
        for user in (admin, owner, editor, viewer, grouped, member)
    }
    as_viewer, as_editor = seen[viewer.id], seen[editor.id]
    assert "Draft" not in as_viewer and "qualityIssues" in as_editor["Draft"]["document"]
    assert "qualityIssues" not in as_viewer["Published"]["document"]
    assert as_editor["Published child"]["document"]["concepts"]
    assert as_viewer["Restricted"]["access"] == "READER"
    assert as_viewer["Restricted"]["collection"]["documentCount"] == 3
    assert as_editor["Restricted"]["collection"]["documentCount"] == 3
    assert as_editor["Inherited"]["collection"]["childCount"] == 3
    assert as_viewer["Inherited"]["collection"]["childCount"] == 2
    assert as_editor["Pending upload"]["document"].get("uploadUri")
    assert not as_viewer["Pending upload"]["document"].get("uploadUri")
    assert as_viewer["Everyone"]["collection"]["shortcutCount"] == 1
    assert seen[admin.id]["Everyone"]["collection"]["shortcutCount"] == 2
    assert seen[member.id]["Everyone"]["collection"]["shortcutCount"] == 0
    assert seen[member.id]["Discoverable"]["access"] == "LOCKED"
    assert ancestors(as_viewer["Opened document"]) == ["Discoverable", "Opened"]
    assert ancestors(as_viewer["Personal document"]) == ["Mine"]
    assert ancestors(seen[grouped.id]["Behind boundary"]) == ["Boundary"]
    assert ancestors(seen[owner.id]["Deleted draft"]) == [
        "Restricted",
        "Deleted",
        "Deleted nested",
    ]
    assert seen[owner.id]["Deleted document"]["state"] == "DELETED"
    assert seen[owner.id]["Deleted"]["collection"].get("childCount") is None
    assert "Deleted document" not in as_editor and "Deleted document" not in as_viewer
    assert item_name(restricted) in {a["name"] for a in as_viewer["Published"]["ancestors"]}
