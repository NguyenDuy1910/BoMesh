"""ImportCollections: a folder tree's missing folders under a collection (item_model.md §7)."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select

from bomesh.db.models import AuditLog, Item
from knowledge_support import item_name, item_url

pytestmark = pytest.mark.asyncio


async def _import(api, collection: Item, rows: list[dict[str, Any]], **extra: Any):
    return await api.post(
        item_url(collection, ":importCollections"), json={"rows": rows, **extra}
    )


async def _children(sessions, parent_id) -> dict[str, Item]:
    async with sessions.begin() as session:
        rows = await session.scalars(
            select(Item).where(Item.parent_item_id == parent_id, Item.deleted_at.is_(None))
        )
        return {row.item_name: row for row in rows}


async def _count(sessions, model, *where) -> int:
    async with sessions.begin() as session:
        return int(await session.scalar(select(func.count()).select_from(model).where(*where)))


async def test_import_creates_missing_folders_parents_first_and_reruns_as_no_op(
    client, world, sessions
):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws, item_name="University")
    faculty = await world.make_collection(ws, root, item_name="Faculty of IT")
    api = await client.as_(admin)
    rows = [
        {"path": [" faculty   OF it "]},
        {"path": ["Faculty of IT", "Slides"], "description": "Lecture slides"},
        {"path": ["Law", "Year 1", "Exams"], "description": "Past exams"},
        {"path": ["Law "], "description": "Faculty of Law"},
    ]
    expected = [
        {"path": ["Faculty of IT", "Slides"], "row": 2},
        {"path": ["Law"], "row": 4},
        {"path": ["Law", "Year 1"]},
        {"path": ["Law", "Year 1", "Exams"], "row": 3},
    ]

    preview = await _import(api, root, rows, validateOnly=True)

    assert preview.status_code == 200, preview.text
    assert preview.json() == {"created": expected, "unchangedCount": 1, "skippedRows": []}
    assert await _count(sessions, Item, Item.tenant_id == ws.id) == 2
    assert await _count(sessions, AuditLog, AuditLog.action == "ImportCollections") == 0

    response = await _import(api, root, rows)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [{k: v for k, v in c.items() if k != "item"} for c in body["created"]] == expected
    assert body["unchangedCount"] == 1 and body["skippedRows"] == []
    slides = (await _children(sessions, faculty.id))["Slides"]
    law = (await _children(sessions, root.id))["Law"]
    year = (await _children(sessions, law.id))["Year 1"]
    exams = (await _children(sessions, year.id))["Exams"]
    assert [c["item"] for c in body["created"]] == [
        item_name(slides), item_name(law), item_name(year), item_name(exams)
    ]
    assert (slides.description, law.description, year.description, exams.description) == (
        "Lecture slides", "Faculty of Law", None, "Past exams"
    )
    assert all(
        folder.item_kind == "collection" and folder.inherit_access and not folder.discoverable
        and folder.created_by_user_id == admin.id
        for folder in (slides, law, year, exams)
    )
    async with sessions.begin() as session:
        audits = (
            await session.scalars(select(AuditLog).where(AuditLog.action == "ImportCollections"))
        ).all()
    assert [(a.target_name, a.details) for a in audits] == [
        (item_name(root), {"createdCount": 4})
    ]

    rerun = await _import(api, root, rows)

    assert rerun.status_code == 200, rerun.text
    assert rerun.json() == {"created": [], "unchangedCount": 4, "skippedRows": []}
    assert await _count(sessions, Item, Item.tenant_id == ws.id) == 6
    assert await _count(sessions, AuditLog, AuditLog.action == "ImportCollections") == 1


async def test_import_skips_rows_with_their_reason(client, world, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    await world.make_collection(ws, root, item_name="Shared")
    await world.make_collection(ws, root, item_name="SHARED")
    api = await client.as_(admin)

    response = await _import(
        api,
        root,
        [
            {"path": ["Shared", "Minutes"]},
            {"path": ["shared", "Notes"]},
            {"path": ["Shared"]},
            {"path": ["Archive"]},
            {"path": [" archive"]},
            {"path": ["Archive", "  "]},
            {"path": ["x" * 513]},
            {"path": [f"Level {n}" for n in range(9)]},
        ],
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "created": [{"path": ["Archive"], "row": 4, "item": response.json()["created"][0]["item"]}],
        "unchangedCount": 0,
        "skippedRows": [
            {"row": 1, "reason": "More than one folder here has this name."},
            {"row": 2, "reason": "A folder above it was skipped."},
            {"row": 3, "reason": "More than one folder here has this name."},
            {"row": 5, "reason": "This folder is already listed in an earlier row."},
            {"row": 6, "reason": "Every folder name must be 1 to 512 characters."},
            {"row": 7, "reason": "Every folder name must be 1 to 512 characters."},
            {"row": 8, "reason": "A path can be at most 8 folders deep."},
        ],
    }
    assert sorted(await _children(sessions, root.id)) == ["Archive", "SHARED", "Shared"]


async def test_unreadable_restricted_folder_is_absent(client, world, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    root = await world.make_collection(ws, grants={editor: "roles/collectionEditor"})
    secret = await world.make_collection(ws, root, item_name="Secret", inherit_access=False)
    api = await client.as_(editor)

    response = await _import(api, root, [{"path": ["Secret", "Plans"]}])

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(c["path"], c.get("row")) for c in body["created"]] == [
        (["Secret"], None),
        (["Secret", "Plans"], 1),
    ]
    async with sessions.begin() as session:
        secrets = (
            await session.scalars(
                select(Item).where(Item.parent_item_id == root.id, Item.item_name == "Secret")
            )
        ).all()
    assert len(secrets) == 2
    assert await _children(sessions, secret.id) == {}


async def test_import_needs_items_create_here_and_in_own_access_folders(client, world, sessions):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    editor = await world.add_member(ws)
    viewer = await world.add_member(ws)
    root = await world.make_collection(
        ws, grants={editor: "roles/collectionEditor", viewer: "roles/collectionViewer"}
    )
    await world.make_collection(
        ws, root, item_name="Records", inherit_access=False, grants={editor: "roles/collectionViewer"}
    )
    rows = [
        {"path": ["Records"]},
        {"path": ["Records", "2024"]},
        {"path": ["Records", "2024", "Q1"]},
        {"path": ["Projects"]},
    ]

    denied = await _import(await client.as_(viewer), root, rows)

    assert denied.status_code == 403, denied.text
    assert denied.json()["error"]["status"] == "PERMISSION_DENIED"

    response = await _import(await client.as_(editor), root, rows)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(c["path"], c["row"]) for c in body["created"]] == [(["Projects"], 4)]
    assert body["unchangedCount"] == 1
    assert body["skippedRows"] == [
        {"row": 2, "reason": "You can't add folders inside this folder."},
        {"row": 3, "reason": "A folder above it was skipped."},
    ]
    assert sorted(await _children(sessions, root.id)) == ["Projects", "Records"]
